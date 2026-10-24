use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::Session;
use async_native_tls::TlsStream;
use futures::TryStreamExt;
use rusqlite::{params, Connection};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;

use crate::db::{get_setting, get_settings, set_setting};
use crate::parse::parse_raw_email;

const IMAP_HOST: &str = "imap.seznam.cz";
const IMAP_PORT: u16 = 993;
const TIMEOUT: Duration = Duration::from_secs(10);

// Batch size for fetching full emails
const BATCH_SIZE: usize = 10;
// How many emails to look at per sync cycle
const EMAILS_PER_SYNC: usize = 50;

pub type ImapSession = Session<TlsStream<TcpStream>>;
type Db = Arc<Mutex<Connection>>;

pub async fn connect(email: &str, password: &str) -> Result<ImapSession, String> {
    let login = async {
        let tcp = TcpStream::connect((IMAP_HOST, IMAP_PORT))
            .await
            .map_err(|e| e.to_string())?;
        let tls = async_native_tls::TlsConnector::new()
            .connect(IMAP_HOST, tcp)
            .await
            .map_err(|e| e.to_string())?;
        async_imap::Client::new(tls)
            .login(email, password)
            .await
            .map_err(|(e, _)| e.to_string())
    };
    tokio::time::timeout(TIMEOUT, login)
        .await
        .map_err(|_| "Server neodpovídá".to_string())?
}

fn emit_status(app: &AppHandle, status: &str, message: &str, progress: Option<u32>) {
    let mut payload = json!({ "status": status, "message": message });
    if let Some(progress) = progress {
        payload["progress"] = json!(progress);
    }
    let _ = app.emit("sync-status", payload);
}

enum SyncOutcome {
    NoCredentials,
    Done { history_complete: bool },
}

pub async fn run_sync_loop(app: AppHandle, db: Db) {
    loop {
        let delay = match sync_emails(&app, &db).await {
            Ok(SyncOutcome::NoCredentials) => Duration::from_secs(5),
            Ok(SyncOutcome::Done { history_complete: false }) => Duration::from_secs(2),
            Ok(SyncOutcome::Done { history_complete: true }) => {
                // Clear the status after a moment, then check for new emails every 30 seconds
                tokio::time::sleep(Duration::from_secs(3)).await;
                emit_status(&app, "idle", "", None);
                Duration::from_secs(27)
            }
            Err(error) => {
                log::error!("Sync failed: {error}");
                emit_status(&app, "error", &format!("Chyba: {error}"), None);
                Duration::from_secs(10)
            }
        };
        tokio::time::sleep(delay).await;
    }
}

// IMAP SEARCH wants dates like 1-Jan-2024; the setting is stored as YYYY-MM-DD
fn imap_since(date: &str) -> Option<String> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut parts = date.split('-');
    let year: u32 = parts.next()?.parse().ok()?;
    let month: usize = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    Some(format!("SINCE {day}-{}-{year}", MONTHS.get(month.checked_sub(1)?)?))
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

async fn sync_emails(app: &AppHandle, db: &Db) -> Result<SyncOutcome, String> {
    let settings = get_settings(&db.lock().unwrap()).map_err(|e| e.to_string())?;
    let (Some(email), Some(password)) = (settings.get("email"), settings.get("password")) else {
        emit_status(app, "idle", "Čekám na nastavení přihlašovacích údajů", None);
        return Ok(SyncOutcome::NoCredentials);
    };

    emit_status(app, "syncing", "Připojuji se k serveru...", None);
    let mut session = connect(email, password).await.map_err(|e| {
        log::error!("Connection error: {e}");
        "Nelze se připojit k serveru".to_string()
    })?;
    emit_status(app, "syncing", "Kontroluji schránku...", None);

    let mailbox = session.select("INBOX").await.map_err(|e| e.to_string())?;

    // UIDs stay the same when other emails are deleted, unlike sequence numbers.
    // If the server renumbers the mailbox (new UIDVALIDITY), start over; duplicates are skipped by message ID.
    let uid_validity = mailbox.uid_validity.unwrap_or(0).to_string();
    {
        let conn = db.lock().unwrap();
        if get_setting(&conn, "sync_uidvalidity").ok().flatten().as_deref() != Some(&uid_validity) {
            conn.execute(
                "DELETE FROM settings WHERE key IN ('sync_newest_uid', 'sync_oldest_uid')",
                [],
            )
            .map_err(|e| e.to_string())?;
            set_setting(&conn, "sync_uidvalidity", &uid_validity).map_err(|e| e.to_string())?;
        }
    }

    let date_limit = settings.get("sync_from_date").and_then(|d| imap_since(d));
    let query = date_limit.clone().unwrap_or_else(|| "ALL".to_string());
    let mut uids: Vec<u32> = session
        .uid_search(&query)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    uids.sort_unstable();
    log::info!("INBOX has {} messages matching {query}", uids.len());

    if uids.is_empty() {
        let _ = session.logout().await;
        emit_status(app, "success", "Schránka je prázdná", None);
        return Ok(SyncOutcome::Done { history_complete: true });
    }

    let (newest, oldest) = {
        let conn = db.lock().unwrap();
        let read = |key| {
            get_setting(&conn, key)
                .ok()
                .flatten()
                .and_then(|v| v.parse::<u32>().ok())
        };
        (read("sync_newest_uid"), read("sync_oldest_uid"))
    };

    // 1. New emails since the last sync (on the first sync, just the newest batch)
    let new_uids: Vec<u32> = match newest {
        Some(newest) => uids.iter().copied().filter(|&u| u > newest).collect(),
        None => uids[uids.len().saturating_sub(EMAILS_PER_SYNC)..].to_vec(),
    };
    // 2. Older emails, continuing backwards from where the last sync stopped
    let history_uids: Vec<u32> = match oldest {
        Some(oldest) => {
            let older: Vec<u32> = uids.iter().copied().filter(|&u| u < oldest).collect();
            older[older.len().saturating_sub(EMAILS_PER_SYNC)..].to_vec()
        }
        None => Vec::new(),
    };
    log::info!("Sync plan: {} new, {} older", new_uids.len(), history_uids.len());

    let mut new_count = 0;
    fetch_uids(app, db, &mut session, &new_uids, "nové emaily", &mut new_count).await?;
    fetch_uids(app, db, &mut session, &history_uids, "starší emaily", &mut new_count).await?;

    let lowest_processed = new_uids
        .iter()
        .chain(&history_uids)
        .copied()
        .chain(oldest)
        .min();
    {
        let conn = db.lock().unwrap();
        set_setting(&conn, "sync_newest_uid", &uids[uids.len() - 1].to_string())
            .map_err(|e| e.to_string())?;
        if let Some(lowest) = lowest_processed {
            set_setting(&conn, "sync_oldest_uid", &lowest.to_string()).map_err(|e| e.to_string())?;
        }
    }
    let _ = session.logout().await;

    let remaining = lowest_processed.map_or(0, |lowest| uids.iter().filter(|&&u| u < lowest).count());
    let history_complete = remaining == 0;
    let message = if history_complete && date_limit.is_some() {
        format!("Hotovo! Načteno {new_count} emailů (dosaženo datového limitu)")
    } else if history_complete {
        "Hotovo! Všechny emaily synchronizovány".to_string()
    } else if new_count > 0 {
        format!("Načteno {new_count} emailů (zbývá {remaining} starších)")
    } else {
        "Žádné nové emaily".to_string()
    };
    log::info!("Sync complete. Added {new_count} new emails, {remaining} older remaining.");
    emit_status(app, "success", &message, None);
    // The UI reloads the list on this event, so only send it when something arrived
    if new_count > 0 {
        let _ = app.emit("emails-updated", new_count);
    }

    Ok(SyncOutcome::Done { history_complete })
}

// Download and store the given UIDs, skipping emails already in the database
async fn fetch_uids(
    app: &AppHandle,
    db: &Db,
    session: &mut ImapSession,
    uids: &[u32],
    label: &str,
    new_count: &mut usize,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    emit_status(app, "syncing", &format!("Kontroluji {label}..."), None);

    // The envelope carries the Message-ID, which is enough to tell what we already have
    let envelopes: Vec<(u32, String)> = session
        .uid_fetch(uid_set(uids), "ENVELOPE")
        .await
        .map_err(|e| e.to_string())?
        .try_filter_map(|fetch| async move {
            let Some(uid) = fetch.uid else { return Ok(None) };
            let message_id = fetch
                .envelope()
                .and_then(|env| env.message_id.as_ref())
                .map(|id| String::from_utf8_lossy(id).trim().to_string())
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| format!("uid-{uid}"));
            Ok(Some((uid, message_id)))
        })
        .try_collect()
        .await
        .map_err(|e| e.to_string())?;

    let mut missing: Vec<(u32, String)> = {
        let conn = db.lock().unwrap();
        let mut exists = conn
            .prepare("SELECT 1 FROM emails WHERE message_id = ?")
            .map_err(|e| e.to_string())?;
        envelopes
            .into_iter()
            .filter(|(_, id)| !exists.exists([id]).unwrap_or(false))
            .collect()
    };
    if missing.is_empty() {
        return Ok(());
    }
    // Newest first
    missing.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    log::info!("Found {} new emails to fetch", missing.len());

    for (batch_index, batch) in missing.chunks(BATCH_SIZE).enumerate() {
        let done = ((batch_index + 1) * BATCH_SIZE).min(missing.len());
        let progress = (done * 100 / missing.len()) as u32;
        emit_status(
            app,
            "syncing",
            &format!("Stahuji {done}/{} emailů...", missing.len()),
            Some(progress),
        );

        // BODY.PEEK leaves the email unread on the server
        let batch_uids: Vec<u32> = batch.iter().map(|(uid, _)| *uid).collect();
        let fetched: Vec<(u32, Vec<u8>)> = match session
            .uid_fetch(uid_set(&batch_uids), "BODY.PEEK[]")
            .await
        {
            Ok(stream) => stream
                .try_filter_map(|fetch| async move {
                    Ok(fetch.uid.zip(fetch.body().map(<[u8]>::to_vec)))
                })
                .try_collect()
                .await
                .map_err(|e| e.to_string())?,
            Err(e) => {
                log::error!("Error fetching batch: {e}");
                continue;
            }
        };

        // Parse the whole batch first, then write it in a single transaction
        let rows: Vec<_> = fetched
            .into_iter()
            .filter_map(|(uid, raw)| {
                let parsed = parse_raw_email(&raw)?;
                let envelope_id = batch.iter().find(|(u, _)| *u == uid).map(|(_, id)| id.clone());
                Some((parsed, envelope_id, raw, uid))
            })
            .collect();

        let inserted = {
            let mut conn = db.lock().unwrap();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let mut inserted = 0;
            {
                let mut insert = tx
                    .prepare(
                        "INSERT OR IGNORE INTO emails (
                          message_id, from_addr, from_name, to_addr, subject,
                          body_html, body_text, preview, raw_content, date, thread_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .map_err(|e| e.to_string())?;
                for (p, envelope_id, raw, uid) in &rows {
                    let message_id = p
                        .message_id
                        .clone()
                        .or_else(|| envelope_id.clone())
                        .unwrap_or_else(|| format!("uid-{uid}"));
                    let date = p.date.unwrap_or_else(|| {
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_secs() as i64)
                    });
                    inserted += insert
                        .execute(params![
                            message_id, p.from_addr, p.from_name, p.to_addr, p.subject,
                            p.body_html, p.body_text, p.preview, raw, date, p.in_reply_to
                        ])
                        .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            inserted
        };

        *new_count += inserted;
        if *new_count > 0 {
            emit_status(
                app,
                "syncing",
                &format!("Načteno {new_count} emailů..."),
                Some(progress),
            );
            let _ = app.emit("emails-updated", *new_count);
        }
    }
    Ok(())
}
