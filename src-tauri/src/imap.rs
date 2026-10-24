use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::types::{Flag, NameAttribute};
use async_imap::Session;
use async_native_tls::TlsStream;
use futures::TryStreamExt;
use rusqlite::{params, Connection};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::Notify;

use crate::db::{get_setting, get_settings, set_setting};
use crate::parse::parse_raw_email;
use crate::secrets;

const IMAP_HOST: &str = "imap.seznam.cz";
const IMAP_PORT: u16 = 993;
const TIMEOUT: Duration = Duration::from_secs(10);

// Batch size for fetching full emails
const BATCH_SIZE: usize = 10;
// How many emails to look at per sync cycle
const EMAILS_PER_SYNC: usize = 50;
// Keep IMAP commands that list UIDs to a reasonable length
const UIDS_PER_COMMAND: usize = 500;

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

// `wake` cuts the wait short, so reads and deletes reach the server right away
pub async fn run_sync_loop(app: AppHandle, db: Db, wake: Arc<Notify>) {
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
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = wake.notified() => {}
        }
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

// Find a folder by its role (Trash, Sent), falling back to Seznam's folder name
pub async fn find_folder(
    session: &mut ImapSession,
    role: NameAttribute<'static>,
    fallback: &str,
) -> String {
    let names: Vec<_> = match session.list(Some(""), Some("*")).await {
        Ok(stream) => stream.try_collect().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    names
        .iter()
        .find(|name| name.attributes().contains(&role))
        .map(|name| name.name().to_string())
        .unwrap_or_else(|| fallback.to_string())
}

// Send reads and deletes made in DadMail to the server
async fn push_pending_actions(session: &mut ImapSession, db: &Db) -> Result<(), String> {
    let pending = |action: &str| -> Result<Vec<u32>, String> {
        let conn = db.lock().unwrap();
        conn.prepare("SELECT uid FROM emails WHERE pending_action = ? AND uid IS NOT NULL")
            .and_then(|mut stmt| stmt.query_map([action], |r| r.get(0))?.collect())
            .map_err(|e| e.to_string())
    };

    let reads = pending("read")?;
    for chunk in reads.chunks(UIDS_PER_COMMAND) {
        session
            .uid_store(uid_set(chunk), "+FLAGS.SILENT (\\Seen)")
            .await
            .map_err(|e| e.to_string())?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| e.to_string())?;
        let conn = db.lock().unwrap();
        for uid in chunk {
            conn.execute(
                "UPDATE emails SET pending_action = NULL WHERE uid = ? AND pending_action = 'read'",
                [uid],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    let deletes = pending("delete")?;
    if !deletes.is_empty() {
        let trash = find_folder(session, NameAttribute::Trash, "trash").await;
        for chunk in deletes.chunks(UIDS_PER_COMMAND) {
            session
                .uid_mv(uid_set(chunk), &trash)
                .await
                .map_err(|e| e.to_string())?;
            // The email is no longer in INBOX, so its UID there no longer applies
            let conn = db.lock().unwrap();
            for uid in chunk {
                conn.execute(
                    "UPDATE emails SET pending_action = NULL, uid = NULL WHERE uid = ?",
                    [uid],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    if !reads.is_empty() || !deletes.is_empty() {
        log::info!("Sent to server: {} read, {} moved to trash", reads.len(), deletes.len());
    }
    Ok(())
}

// Emails stored before DadMail tracked UIDs: find their UIDs by Message-ID.
// Runs once per UIDVALIDITY; emails downloaded later get their UID when stored.
async fn map_missing_uids(session: &mut ImapSession, db: &Db, all_uids: &[u32]) -> Result<(), String> {
    let known: HashSet<u32> = {
        let conn = db.lock().unwrap();
        conn.prepare("SELECT uid FROM emails WHERE uid IS NOT NULL")
            .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
            .map_err(|e| e.to_string())?
    };
    let unknown: Vec<u32> = all_uids.iter().copied().filter(|u| !known.contains(u)).collect();
    let mut mapped = 0;
    for chunk in unknown.chunks(UIDS_PER_COMMAND) {
        let envelopes = fetch_message_ids(session, chunk).await?;
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (uid, message_id) in envelopes {
            mapped += tx
                .execute(
                    "UPDATE emails SET uid = ? WHERE message_id = ? AND uid IS NULL",
                    params![uid, message_id],
                )
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    log::info!("Matched {mapped} stored emails to their server UIDs");
    Ok(())
}

// Bring read state and deletions made elsewhere (webmail, phone) into DadMail.
// Returns how many emails changed.
async fn pull_server_changes(session: &mut ImapSession, db: &Db, all_uids: &[u32]) -> Result<usize, String> {
    let seen: HashMap<u32, bool> = session
        .uid_fetch("1:*", "FLAGS")
        .await
        .map_err(|e| e.to_string())?
        .try_filter_map(|fetch| async move {
            Ok(fetch.uid.map(|uid| (uid, fetch.flags().any(|f| f == Flag::Seen))))
        })
        .try_collect()
        .await
        .map_err(|e| e.to_string())?;
    let on_server: HashSet<u32> = all_uids.iter().copied().collect();

    let mut conn = db.lock().unwrap();
    let local: Vec<(i64, u32, bool)> = conn
        .prepare(
            "SELECT id, uid, is_read FROM emails
             WHERE uid IS NOT NULL AND is_deleted = 0 AND pending_action IS NULL",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)))?
                .collect()
        })
        .map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut changed = 0;
    for (id, uid, is_read) in local {
        if !on_server.contains(&uid) {
            tx.execute("UPDATE emails SET is_deleted = 1, uid = NULL WHERE id = ?", [id])
                .map_err(|e| e.to_string())?;
            changed += 1;
        } else if let Some(&server_read) = seen.get(&uid) {
            if server_read != is_read {
                tx.execute("UPDATE emails SET is_read = ? WHERE id = ?", params![server_read, id])
                    .map_err(|e| e.to_string())?;
                changed += 1;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    if changed > 0 {
        log::info!("Applied {changed} read or delete changes from the server");
    }
    Ok(changed)
}

// UID and Message-ID of the given emails, from their envelopes
async fn fetch_message_ids(session: &mut ImapSession, uids: &[u32]) -> Result<Vec<(u32, String)>, String> {
    session
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
        .map_err(|e| e.to_string())
}

// Save a sent email to the server's Sent folder, unless the server already put it there
pub async fn save_to_sent(email: &str, password: &str, message_id: &str, raw: &[u8]) -> Result<(), String> {
    let mut session = connect(email, password).await?;
    let sent = find_folder(&mut session, NameAttribute::Sent, "sent").await;
    // Give the server a moment in case it files sent mail itself
    tokio::time::sleep(Duration::from_secs(2)).await;
    session.select(&sent).await.map_err(|e| e.to_string())?;
    let already_there = !session
        .uid_search(format!("HEADER Message-ID \"{}\"", message_id.replace('"', "")))
        .await
        .map_err(|e| e.to_string())?
        .is_empty();
    if already_there {
        log::info!("The server already saved the sent email");
    } else {
        session
            .append(&sent, Some("(\\Seen)"), None, raw)
            .await
            .map_err(|e| e.to_string())?;
        log::info!("Saved the sent email to {sent}");
    }
    let _ = session.logout().await;
    Ok(())
}

async fn sync_emails(app: &AppHandle, db: &Db) -> Result<SyncOutcome, String> {
    let settings = get_settings(&db.lock().unwrap()).map_err(|e| e.to_string())?;
    let email = settings.get("email");
    let password = email.and_then(|e| secrets::get_password(e));
    let (Some(email), Some(password)) = (email, password) else {
        emit_status(app, "idle", "Čekám na nastavení přihlašovacích údajů", None);
        return Ok(SyncOutcome::NoCredentials);
    };

    emit_status(app, "syncing", "Připojuji se k serveru...", None);
    let mut session = connect(email, &password).await.map_err(|e| {
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
                "DELETE FROM settings WHERE key IN ('sync_newest_uid', 'sync_oldest_uid', 'sync_uids_matched')",
                [],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("UPDATE emails SET uid = NULL", [])
                .map_err(|e| e.to_string())?;
            set_setting(&conn, "sync_uidvalidity", &uid_validity).map_err(|e| e.to_string())?;
        }
    }

    let mut all_uids: Vec<u32> = session
        .uid_search("ALL")
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    all_uids.sort_unstable();

    let uids_matched = get_setting(&db.lock().unwrap(), "sync_uids_matched").ok().flatten();
    if uids_matched.as_deref() != Some(&uid_validity) {
        map_missing_uids(&mut session, db, &all_uids).await?;
        set_setting(&db.lock().unwrap(), "sync_uids_matched", &uid_validity).map_err(|e| e.to_string())?;
    }
    push_pending_actions(&mut session, db).await?;
    let server_changes = pull_server_changes(&mut session, db, &all_uids).await?;

    let date_limit = settings.get("sync_from_date").and_then(|d| imap_since(d));
    let uids: Vec<u32> = match &date_limit {
        Some(query) => {
            let mut uids: Vec<u32> = session
                .uid_search(query)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .collect();
            uids.sort_unstable();
            uids
        }
        None => all_uids.clone(),
    };
    let query = date_limit.as_deref().unwrap_or("ALL");
    log::info!("INBOX has {} messages matching {query}", uids.len());

    if uids.is_empty() {
        let _ = session.logout().await;
        emit_status(app, "success", "Schránka je prázdná", None);
        if server_changes > 0 {
            let _ = app.emit("emails-updated", 0);
        }
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
    // The UI reloads the list on this event, so only send it when something changed
    if new_count > 0 || server_changes > 0 {
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
    let envelopes = fetch_message_ids(session, uids).await?;

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
                          body_html, body_text, preview, raw_content, date, thread_id, uid
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                            p.body_html, p.body_text, p.preview, raw, date, p.in_reply_to, uid
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
