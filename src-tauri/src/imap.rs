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

use crate::db::{get_setting, get_settings, set_setting, FOLDERS};
use crate::parse::parse_raw_email;
use crate::{errors, secrets};

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

// A newly downloaded email, for the new-mail notification
pub struct NewEmail {
    pub from: String,
    pub subject: String,
}
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
        .map_err(|_| errors::NO_CONNECTION.to_string())?
        .map_err(|e| errors::describe(&e))
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
                emit_status(&app, "error", &errors::describe(&error), None);
                Duration::from_secs(10)
            }
        };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = wake.notified() => {}
        }
    }
}

// Which emails to fetch this round, from the server's UIDs (sorted ascending) and how far
// earlier syncs got. Returns (new emails, older emails).
fn plan_sync(uids: &[u32], newest: Option<u32>, oldest: Option<u32>) -> (Vec<u32>, Vec<u32>) {
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
    (new_uids, history_uids)
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

// The settings key for a folder's sync state. The inbox keeps the names from before folders.
fn state_key(folder: &str, base: &str) -> String {
    if folder == "inbox" {
        base.to_string()
    } else {
        format!("{base}:{folder}")
    }
}

fn read_uid_setting(db: &Db, key: &str) -> Option<u32> {
    get_setting(&db.lock().unwrap(), key)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
}

fn query_uids(db: &Db, sql: &str, folder: &str) -> Result<Vec<u32>, String> {
    let conn = db.lock().unwrap();
    conn.prepare(sql)
        .and_then(|mut stmt| stmt.query_map([folder], |r| r.get(0))?.collect())
        .map_err(|e| e.to_string())
}

// Find the server UIDs of emails in this folder that don't have one yet: emails from before
// DadMail tracked UIDs (all of the folder is checked once), and emails just moved here
// (the server gives them new, higher UIDs).
async fn map_missing_uids(
    session: &mut ImapSession,
    db: &Db,
    folder: &str,
    all_uids: &[u32],
    first_time: bool,
) -> Result<(), String> {
    let waiting = query_uids(db, "SELECT 1 FROM emails WHERE server_folder = ? AND uid IS NULL LIMIT 1", folder)?;
    if waiting.is_empty() {
        return Ok(());
    }
    let known: HashSet<u32> = query_uids(db, "SELECT uid FROM emails WHERE server_folder = ? AND uid IS NOT NULL", folder)?
        .into_iter()
        .collect();
    let newest_known = known.iter().copied().max().unwrap_or(0);
    let candidates: Vec<u32> = all_uids
        .iter()
        .copied()
        .filter(|u| !known.contains(u) && (first_time || *u > newest_known))
        .collect();
    let mut mapped = 0;
    for chunk in candidates.chunks(UIDS_PER_COMMAND) {
        let envelopes = fetch_message_ids(session, chunk).await?;
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (uid, message_id) in envelopes {
            mapped += tx
                .execute(
                    "UPDATE emails SET uid = ? WHERE server_folder = ? AND message_id = ? AND uid IS NULL",
                    params![uid, folder, message_id],
                )
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    if mapped > 0 {
        log::info!("Matched {mapped} emails in {folder} to their server UIDs");
    }
    Ok(())
}

// Send changes made in DadMail for emails that are in this folder on the server:
// read/unread, then moves (deleting moves to the trash, restoring moves back)
async fn push_pending_actions(
    session: &mut ImapSession,
    db: &Db,
    folder: &str,
    server_names: &HashMap<&str, String>,
) -> Result<(), String> {
    for (action, command) in [("read", "+FLAGS.SILENT (\\Seen)"), ("unread", "-FLAGS.SILENT (\\Seen)")] {
        let uids = {
            let conn = db.lock().unwrap();
            conn.prepare("SELECT uid FROM emails WHERE server_folder = ? AND pending_action = ? AND uid IS NOT NULL")
                .and_then(|mut stmt| stmt.query_map(params![folder, action], |r| r.get::<_, u32>(0))?.collect::<Result<Vec<_>, _>>())
                .map_err(|e| e.to_string())?
        };
        for chunk in uids.chunks(UIDS_PER_COMMAND) {
            session
                .uid_store(uid_set(chunk), command)
                .await
                .map_err(|e| e.to_string())?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|e| e.to_string())?;
            let conn = db.lock().unwrap();
            for uid in chunk {
                conn.execute(
                    "UPDATE emails SET pending_action = NULL WHERE server_folder = ? AND uid = ? AND pending_action = ?",
                    params![folder, uid, action],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if !uids.is_empty() {
            log::info!("Marked {} emails in {folder} as {action} on the server", uids.len());
        }
    }

    for target in FOLDERS.iter().filter(|f| **f != folder) {
        let uids = {
            let conn = db.lock().unwrap();
            conn.prepare("SELECT uid FROM emails WHERE server_folder = ? AND folder = ? AND uid IS NOT NULL")
                .and_then(|mut stmt| stmt.query_map(params![folder, target], |r| r.get::<_, u32>(0))?.collect::<Result<Vec<_>, _>>())
                .map_err(|e| e.to_string())?
        };
        for chunk in uids.chunks(UIDS_PER_COMMAND) {
            session
                .uid_mv(uid_set(chunk), &server_names[target])
                .await
                .map_err(|e| e.to_string())?;
            // Now in the target folder, under a new UID that the next pass there looks up
            let conn = db.lock().unwrap();
            for uid in chunk {
                conn.execute(
                    "UPDATE emails SET server_folder = folder, uid = NULL WHERE server_folder = ? AND uid = ?",
                    params![folder, uid],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if !uids.is_empty() {
            log::info!("Moved {} emails from {folder} to {target} on the server", uids.len());
        }
    }
    Ok(())
}

// Bring read state and removals made elsewhere (webmail, phone) into DadMail.
// An email that is gone from this folder is removed here too; if it was moved,
// the other folder's pass downloads it there. Returns how many emails changed.
async fn pull_server_changes(session: &mut ImapSession, db: &Db, folder: &str, all_uids: &[u32]) -> Result<usize, String> {
    let seen: HashMap<u32, bool> = if all_uids.is_empty() {
        HashMap::new()
    } else {
        session
            .uid_fetch("1:*", "FLAGS")
            .await
            .map_err(|e| e.to_string())?
            .try_filter_map(|fetch| async move {
                Ok(fetch.uid.map(|uid| (uid, fetch.flags().any(|f| f == Flag::Seen))))
            })
            .try_collect()
            .await
            .map_err(|e| e.to_string())?
    };
    let on_server: HashSet<u32> = all_uids.iter().copied().collect();

    let mut conn = db.lock().unwrap();
    let local: Vec<(i64, u32, bool)> = conn
        .prepare(
            "SELECT id, uid, is_read FROM emails
             WHERE server_folder = ?1 AND folder = ?1 AND uid IS NOT NULL AND pending_action IS NULL",
        )
        .and_then(|mut stmt| {
            stmt.query_map([folder], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)))?
                .collect()
        })
        .map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut changed = 0;
    for (id, uid, is_read) in local {
        if !on_server.contains(&uid) {
            tx.execute("DELETE FROM emails WHERE id = ?", [id])
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
        log::info!("Applied {changed} changes from the server in {folder}");
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

struct FolderResult {
    arrived: Vec<NewEmail>,
    older: usize,
    remaining: usize,
    changes: usize,
}

async fn sync_emails(app: &AppHandle, db: &Db) -> Result<SyncOutcome, String> {
    let settings = get_settings(&db.lock().unwrap()).map_err(|e| e.to_string())?;
    let email = settings.get("email");
    let password = email.and_then(|e| secrets::get_password(e));
    let (Some(email), Some(password)) = (email, password) else {
        emit_status(app, "idle", "Čekám na nastavení přihlašovacích údajů", None);
        return Ok(SyncOutcome::NoCredentials);
    };

    let mut session = connect(email, &password).await?;
    let server_names: HashMap<&str, String> = HashMap::from([
        ("inbox", "INBOX".to_string()),
        ("sent", find_folder(&mut session, NameAttribute::Sent, "sent").await),
        ("trash", find_folder(&mut session, NameAttribute::Trash, "trash").await),
    ]);
    let date_limit = settings.get("sync_from_date").and_then(|d| imap_since(d));

    let mut arrived = Vec::new();
    let (mut downloaded, mut remaining, mut changes) = (0, 0, 0);
    for folder in FOLDERS {
        let result = sync_folder(app, db, &mut session, folder, &server_names, date_limit.as_deref()).await?;
        downloaded += result.arrived.len() + result.older;
        remaining += result.remaining;
        changes += result.changes;
        if folder == "inbox" {
            arrived = result.arrived;
        }
    }
    let _ = session.logout().await;

    if !arrived.is_empty() {
        crate::notify_new_mail(app, &arrived);
    }
    log::info!("Sync complete. {downloaded} downloaded, {changes} changes, {remaining} older remaining.");

    // Background checks stay quiet unless emails are still downloading
    if remaining > 0 {
        emit_status(app, "syncing", &format!("Stahuji starší emaily, zbývá {remaining}"), None);
    } else {
        emit_status(app, "idle", "", None);
    }
    if downloaded > 0 || changes > 0 {
        crate::update_unread_count(app, &db.lock().unwrap());
        let _ = app.emit("emails-updated", arrived.len());
    }
    Ok(SyncOutcome::Done { history_complete: remaining == 0 })
}

async fn sync_folder(
    app: &AppHandle,
    db: &Db,
    session: &mut ImapSession,
    folder: &str,
    server_names: &HashMap<&str, String>,
    date_limit: Option<&str>,
) -> Result<FolderResult, String> {
    let key = |base: &str| state_key(folder, base);
    let mailbox = session.select(&server_names[folder]).await.map_err(|e| e.to_string())?;

    // UIDs stay the same when other emails are deleted, unlike sequence numbers.
    // If the server renumbers the folder (new UIDVALIDITY), start over; duplicates are skipped by message ID.
    let uid_validity = mailbox.uid_validity.unwrap_or(0).to_string();
    {
        let conn = db.lock().unwrap();
        if get_setting(&conn, &key("sync_uidvalidity")).ok().flatten().as_deref() != Some(&uid_validity) {
            for base in ["sync_newest_uid", "sync_oldest_uid", "sync_uids_matched"] {
                conn.execute("DELETE FROM settings WHERE key = ?", [key(base)])
                    .map_err(|e| e.to_string())?;
            }
            conn.execute("UPDATE emails SET uid = NULL WHERE server_folder = ?", [folder])
                .map_err(|e| e.to_string())?;
            set_setting(&conn, &key("sync_uidvalidity"), &uid_validity).map_err(|e| e.to_string())?;
        }
    }

    let mut all_uids: Vec<u32> = session
        .uid_search("ALL")
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    all_uids.sort_unstable();

    let matched = get_setting(&db.lock().unwrap(), &key("sync_uids_matched")).ok().flatten();
    let first_time = matched.as_deref() != Some(&uid_validity);
    map_missing_uids(session, db, folder, &all_uids, first_time).await?;
    if first_time {
        set_setting(&db.lock().unwrap(), &key("sync_uids_matched"), &uid_validity).map_err(|e| e.to_string())?;
    }

    push_pending_actions(session, db, folder, server_names).await?;
    let mut changes = pull_server_changes(session, db, folder, &all_uids).await?;

    // Moves above may have changed the folder; look again before downloading
    let uids: Vec<u32> = {
        let query = date_limit.unwrap_or("ALL");
        let mut uids: Vec<u32> = session
            .uid_search(query)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        uids.sort_unstable();
        uids
    };
    if uids.is_empty() {
        return Ok(FolderResult { arrived: Vec::new(), older: 0, remaining: 0, changes });
    }

    let newest = read_uid_setting(db, &key("sync_newest_uid"));
    let oldest = read_uid_setting(db, &key("sync_oldest_uid"));
    let (new_uids, history_uids) = plan_sync(&uids, newest, oldest);

    let mut arrived = Vec::new();
    fetch_uids(app, db, session, folder, &new_uids, &mut arrived).await?;
    let mut older = Vec::new();
    fetch_uids(app, db, session, folder, &history_uids, &mut older).await?;
    changes += arrived.len() + older.len();
    // The first download of a folder is not "new mail"
    if newest.is_none() {
        older.append(&mut arrived);
    }

    let lowest_processed = new_uids.iter().chain(&history_uids).copied().chain(oldest).min();
    {
        let conn = db.lock().unwrap();
        set_setting(&conn, &key("sync_newest_uid"), &uids[uids.len() - 1].to_string())
            .map_err(|e| e.to_string())?;
        if let Some(lowest) = lowest_processed {
            set_setting(&conn, &key("sync_oldest_uid"), &lowest.to_string()).map_err(|e| e.to_string())?;
        }
    }
    let remaining = lowest_processed.map_or(0, |lowest| uids.iter().filter(|&&u| u < lowest).count());
    Ok(FolderResult { arrived, older: older.len(), remaining, changes })
}

// Download and store the given UIDs, skipping emails already in the database
async fn fetch_uids(
    app: &AppHandle,
    db: &Db,
    session: &mut ImapSession,
    folder: &str,
    uids: &[u32],
    new_emails: &mut Vec<NewEmail>,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    // The envelope carries the Message-ID, which is enough to tell what we already have
    let envelopes = fetch_message_ids(session, uids).await?;

    let mut missing: Vec<(u32, String)> = {
        let conn = db.lock().unwrap();
        let mut exists = conn
            .prepare("SELECT 1 FROM emails WHERE folder = ? AND message_id = ?")
            .map_err(|e| e.to_string())?;
        envelopes
            .into_iter()
            .filter(|(_, id)| !exists.exists(params![folder, id]).unwrap_or(false))
            .collect()
    };
    if missing.is_empty() {
        return Ok(());
    }
    // Newest first
    missing.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    log::info!("Found {} emails to fetch in {folder}", missing.len());

    for (batch_index, batch) in missing.chunks(BATCH_SIZE).enumerate() {
        let done = ((batch_index + 1) * BATCH_SIZE).min(missing.len());
        let progress = (done * 100 / missing.len()) as u32;
        emit_status(app, "syncing", &format!("Stahuji emaily: {done} z {}", missing.len()), Some(progress));

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
                          folder, server_folder, message_id, from_addr, from_name, to_addr, subject,
                          body_html, body_text, preview, date, thread_id, uid, is_read
                        ) VALUES (?1, ?1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .map_err(|e| e.to_string())?;
                let mut insert_raw = tx
                    .prepare("INSERT INTO email_raw (email_id, raw) VALUES (?, ?)")
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
                    // Sent emails are the user's own: never unread
                    let added = insert
                        .execute(params![
                            folder, message_id, p.from_addr, p.from_name, p.to_addr, p.subject,
                            p.body_html, p.body_text, p.preview, date, p.in_reply_to, uid, folder == "sent"
                        ])
                        .map_err(|e| e.to_string())?;
                    if added > 0 {
                        insert_raw
                            .execute(params![tx.last_insert_rowid(), raw])
                            .map_err(|e| e.to_string())?;
                        new_emails.push(NewEmail {
                            from: p.from_name.clone(),
                            subject: p.subject.clone(),
                        });
                        inserted += 1;
                    }
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            inserted
        };

        if inserted > 0 {
            // Let the list show new emails while the rest are still downloading
            let _ = app.emit("emails-updated", 0);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sync_takes_the_newest_batch() {
        let uids: Vec<u32> = (1..=120).collect();
        let (new, older) = plan_sync(&uids, None, None);
        assert_eq!(new, (71..=120).collect::<Vec<_>>());
        assert!(older.is_empty());
    }

    #[test]
    fn later_syncs_fetch_new_mail_and_continue_backwards() {
        // Emails 1-4 were deleted on the server; UIDs keep their numbers
        let uids: Vec<u32> = (5..=200).collect();
        let (new, older) = plan_sync(&uids, Some(190), Some(100));
        assert_eq!(new, (191..=200).collect::<Vec<_>>());
        assert_eq!(older, (50..=99).collect::<Vec<_>>());

        let (new, older) = plan_sync(&uids, Some(200), Some(5));
        assert!(new.is_empty() && older.is_empty());
    }

    #[test]
    fn date_limit_uses_imap_date_format() {
        assert_eq!(imap_since("2024-01-05").as_deref(), Some("SINCE 5-Jan-2024"));
        assert_eq!(imap_since("2024-13-05"), None);
        assert_eq!(imap_since("nonsense"), None);
    }
}
