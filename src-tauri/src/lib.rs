mod db;
mod errors;
mod imap;
mod parse;
mod secrets;
mod smtp;
mod telemetry;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalSize, Manager, State, UserAttentionType};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

struct AppState {
    db: Arc<Mutex<Connection>>,
    // Wakes the sync loop so reads and deletes reach the server right away
    sync_now: Arc<Notify>,
}

type CommandResult<T> = Result<T, String>;

fn to_string_error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// Only the columns the list shows; full bodies are loaded by get_email when opened
#[derive(Serialize)]
struct EmailListItem {
    id: i64,
    from_addr: String,
    from_name: String,
    to_addr: String,
    subject: String,
    preview: Option<String>,
    date: i64,
    is_read: i64,
}

#[derive(Serialize)]
struct Email {
    id: i64,
    folder: String,
    message_id: String,
    from_addr: String,
    from_name: String,
    to_addr: String,
    subject: String,
    body_html: Option<String>,
    body_text: Option<String>,
    date: i64,
    is_read: i64,
    thread_id: Option<String>,
    attachments: Vec<parse::AttachmentInfo>,
}

// Czech needs three forms: 1 nový email, 2–4 nové emaily, 5 nových emailů
fn czech_count(n: i64, one: &str, few: &str, many: &str) -> String {
    let form = match n {
        1 => one,
        2..=4 => few,
        _ => many,
    };
    format!("{n} {form}")
}

// Unread count in the window title (shown on the Windows taskbar) and on the macOS dock icon
pub(crate) fn update_unread_count(app: &AppHandle, conn: &Connection) {
    let unread: i64 = conn
        .query_row("SELECT count(*) FROM emails WHERE is_read = 0 AND folder = 'inbox'", [], |r| r.get(0))
        .unwrap_or(0);
    let Some(window) = app.get_webview_window("main") else { return };
    let title = if unread == 0 {
        "DadMail".to_string()
    } else {
        format!(
            "DadMail – {}",
            czech_count(unread, "nepřečtený email", "nepřečtené emaily", "nepřečtených emailů")
        )
    };
    let _ = window.set_title(&title);
    #[cfg(target_os = "macos")]
    let _ = window.set_badge_count((unread > 0).then_some(unread));
}

pub(crate) fn notify_new_mail(app: &AppHandle, emails: &[imap::NewEmail]) {
    let (title, body) = match emails {
        [email] => (format!("Nový email od {}", email.from), email.subject.clone()),
        _ => {
            let mut senders: Vec<&str> = Vec::new();
            for email in emails {
                if !senders.contains(&email.from.as_str()) {
                    senders.push(&email.from);
                }
            }
            let mut body = format!("Od: {}", senders.iter().take(3).copied().collect::<Vec<_>>().join(", "));
            if senders.len() > 3 {
                body.push_str(" a další");
            }
            (czech_count(emails.len() as i64, "nový email", "nové emaily", "nových emailů"), body)
        }
    };
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::error!("Could not show a notification: {e}");
    }
    // Also flash the taskbar button when DadMail is in the background
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_focused().unwrap_or(true) {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

// Text size: the whole window is zoomed, email contents included. Saved between runs.
#[tauri::command]
async fn set_zoom(app: AppHandle, state: State<'_, AppState>, zoom: f64) -> CommandResult<f64> {
    let zoom = zoom.clamp(0.8, 2.0);
    if let Some(window) = app.get_webview_window("main") {
        window.set_zoom(zoom).map_err(to_string_error)?;
    }
    db::set_setting(&state.db.lock().unwrap(), "zoom", &zoom.to_string()).map_err(to_string_error)?;
    Ok(zoom)
}

// Turn what the user typed into an FTS5 query: every word must match,
// each as a prefix, with FTS syntax characters treated as plain text
fn to_fts_query(search_query: &str) -> String {
    search_query
        .split_whitespace()
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
async fn get_emails(
    state: State<'_, AppState>,
    folder: Option<String>,
    search_query: Option<String>,
) -> CommandResult<Vec<EmailListItem>> {
    let started = std::time::Instant::now();
    let conn = state.db.lock().unwrap();
    let folder = folder.unwrap_or_else(|| "inbox".into());
    let fts_query = to_fts_query(search_query.as_deref().unwrap_or(""));
    let columns = "e.id, e.from_addr, e.from_name, e.to_addr, e.subject, e.preview, e.date, e.is_read";
    let (sql, args): (String, Vec<String>) = if fts_query.is_empty() {
        (
            format!("SELECT {columns} FROM emails e WHERE e.folder = ? ORDER BY e.date DESC"),
            vec![folder],
        )
    } else {
        (
            format!(
                "SELECT {columns} FROM emails_fts
                 JOIN emails e ON e.id = emails_fts.rowid
                 WHERE emails_fts MATCH ? AND e.folder = ?
                 ORDER BY e.date DESC"
            ),
            vec![fts_query, folder],
        )
    };
    let emails = conn
        .prepare(&sql)
        .map_err(to_string_error)?
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok(EmailListItem {
                id: r.get(0)?,
                from_addr: r.get(1)?,
                from_name: r.get(2)?,
                to_addr: r.get(3)?,
                subject: r.get(4)?,
                preview: r.get(5)?,
                date: r.get(6)?,
                is_read: r.get(7)?,
            })
        })
        .map_err(to_string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string_error)?;
    log::info!("get_emails: {} rows in {:?}", emails.len(), started.elapsed());
    Ok(emails)
}

#[tauri::command]
async fn get_email(app: AppHandle, state: State<'_, AppState>, id: i64) -> CommandResult<Option<Email>> {
    let conn = state.db.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT id, message_id, from_addr, from_name, to_addr, subject,
               body_html, body_text, date, is_read, thread_id,
               (SELECT raw FROM email_raw WHERE email_id = emails.id), folder
             FROM emails WHERE id = ?",
            [id],
            |r| {
                Ok((
                    Email {
                        id: r.get(0)?,
                        folder: r.get(12)?,
                        message_id: r.get(1)?,
                        from_addr: r.get(2)?,
                        from_name: r.get(3)?,
                        to_addr: r.get(4)?,
                        subject: r.get(5)?,
                        body_html: r.get(6)?,
                        body_text: r.get(7)?,
                        date: r.get(8)?,
                        is_read: r.get(9)?,
                        thread_id: r.get(10)?,
                        attachments: Vec::new(),
                    },
                    r.get::<_, Option<Vec<u8>>>(11)?,
                ))
            },
        )
        .optional()
        .map_err(to_string_error)?;
    let Some((mut email, raw)) = row else {
        return Ok(None);
    };

    // Attachments and inline images come from the original email
    if let Some(raw) = raw {
        let content = parse::email_content(&raw, email.body_html.as_deref().unwrap_or(""));
        if email.body_html.as_deref().is_some_and(|h| !h.is_empty()) {
            email.body_html = Some(content.body_html);
        }
        email.attachments = content.attachments;
    }

    // Mark as read, here and (on the next sync) on the server
    if email.is_read == 0 {
        conn.execute(
            "UPDATE emails SET is_read = 1, pending_action = 'read' WHERE id = ?",
            [id],
        )
        .map_err(to_string_error)?;
        update_unread_count(&app, &conn);
        state.sync_now.notify_one();
    }
    Ok(Some(email))
}

// Moving between folders happens here right away; the sync then moves the email on the
// server. Deleting does not wake the sync, which leaves time for "Vrátit" (undo).
fn move_email(app: &AppHandle, state: &State<'_, AppState>, id: i64, folder: &str) -> CommandResult<()> {
    let conn = state.db.lock().unwrap();
    match conn.execute("UPDATE emails SET folder = ? WHERE id = ?", params![folder, id]) {
        Ok(_) => {}
        // The same email is already in that folder: this copy can simply go
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            conn.execute("DELETE FROM emails WHERE id = ?", [id]).map_err(to_string_error)?;
        }
        Err(e) => return Err(e.to_string()),
    }
    update_unread_count(app, &conn);
    Ok(())
}

#[tauri::command]
async fn delete_email(app: AppHandle, state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    move_email(&app, &state, id, "trash")
}

// Back to the inbox, from the trash or straight after deleting ("Vrátit")
#[tauri::command]
async fn restore_email(app: AppHandle, state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    move_email(&app, &state, id, "inbox")?;
    state.sync_now.notify_one();
    Ok(())
}

#[tauri::command]
async fn mark_unread(app: AppHandle, state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("UPDATE emails SET is_read = 0, pending_action = 'unread' WHERE id = ?", [id])
        .map_err(to_string_error)?;
    update_unread_count(&app, &conn);
    state.sync_now.notify_one();
    Ok(())
}

// Unread emails per folder, for the folder list
#[tauri::command]
async fn folder_counts(state: State<'_, AppState>) -> CommandResult<HashMap<String, i64>> {
    let conn = state.db.lock().unwrap();
    let mut counts: HashMap<String, i64> = db::FOLDERS.iter().map(|f| (f.to_string(), 0)).collect();
    let rows = conn
        .prepare("SELECT folder, count(*) FROM emails WHERE is_read = 0 GROUP BY folder")
        .and_then(|mut stmt| {
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(to_string_error)?;
    counts.extend(rows);
    Ok(counts)
}

#[derive(Serialize)]
struct Contact {
    name: String,
    address: String,
}

// People Dad has emailed with, for suggestions in "Komu". People he has written to come first;
// automated senders (notifications, newsletters) are left out.
#[tauri::command]
async fn get_contacts(state: State<'_, AppState>) -> CommandResult<Vec<Contact>> {
    let conn = state.db.lock().unwrap();
    let own = db::get_setting(&conn, "email").map_err(to_string_error)?.unwrap_or_default();
    conn.prepare(
        "SELECT address, max(name), sum(weight) AS score, max(date) AS last FROM (
           SELECT lower(from_addr) AS address, from_name AS name, date, 1 AS weight FROM emails WHERE folder != 'sent'
           UNION ALL
           SELECT lower(to_addr), '', date, 10 FROM emails WHERE folder = 'sent'
         )
         WHERE address LIKE '%@%' AND address != lower(?)
           AND address NOT LIKE '%noreply%' AND address NOT LIKE '%no-reply%' AND address NOT LIKE '%donotreply%'
           AND address NOT LIKE '%notifikace%' AND address NOT LIKE '%notification%'
           AND address NOT LIKE '%newsletter%' AND address NOT LIKE '%mailer-daemon%'
         GROUP BY address
         ORDER BY score DESC, last DESC
         LIMIT 300",
    )
    .and_then(|mut stmt| {
        stmt.query_map([own], |r| Ok(Contact { address: r.get(0)?, name: r.get(1)? }))?
            .collect::<Result<Vec<_>, _>>()
    })
    .map_err(to_string_error)
}

// One draft of the email being written, so closing the window by mistake loses nothing
#[tauri::command]
async fn get_draft(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    db::get_setting(&state.db.lock().unwrap(), "draft").map_err(to_string_error)
}

#[tauri::command]
async fn save_draft(state: State<'_, AppState>, draft: Option<String>) -> CommandResult<()> {
    let conn = state.db.lock().unwrap();
    match draft {
        Some(draft) => db::set_setting(&conn, "draft", &draft),
        None => conn.execute("DELETE FROM settings WHERE key = 'draft'", []).map(|_| ()),
    }
    .map_err(to_string_error)
}

#[derive(Serialize)]
struct PickedFile {
    path: String,
    name: String,
    size: u64,
}

// "Přiložit soubor": the system's file picker
#[tauri::command]
async fn pick_files(app: AppHandle) -> CommandResult<Vec<PickedFile>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Vyberte soubory k přiložení").blocking_pick_files();
    let mut files = Vec::new();
    for path in picked.unwrap_or_default() {
        let path = path.into_path().map_err(to_string_error)?;
        let size = std::fs::metadata(&path).map_err(to_string_error)?.len();
        files.push(PickedFile {
            name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size,
        });
    }
    Ok(files)
}

// The password itself never goes to the UI, only whether one is saved
#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> CommandResult<HashMap<String, String>> {
    let mut settings = db::get_settings(&state.db.lock().unwrap()).map_err(to_string_error)?;
    settings.remove("password");
    let has_password = settings
        .get("email")
        .is_some_and(|email| secrets::get_password(email).is_some());
    settings.insert("has_password".into(), if has_password { "1" } else { "0" }.into());
    Ok(settings)
}

// A password in `settings` goes to the system password store; an empty one keeps the saved password
#[tauri::command]
async fn save_settings(state: State<'_, AppState>, mut settings: HashMap<String, String>) -> CommandResult<()> {
    let password = settings.remove("password").filter(|p| !p.is_empty());
    settings.remove("has_password");
    let conn = state.db.lock().unwrap();
    if let Some(password) = password {
        let email = match settings.get("email") {
            Some(email) => email.clone(),
            None => db::get_setting(&conn, "email")
                .map_err(to_string_error)?
                .ok_or("Nejdřív vyplňte email")?,
        };
        secrets::set_password(&email, &password)?;
    }
    for (key, value) in &settings {
        db::set_setting(&conn, key, value).map_err(to_string_error)?;
    }
    if settings.contains_key("telemetry") {
        telemetry::configure(&conn);
    }
    state.sync_now.notify_one();
    Ok(())
}

// Credentials for connecting to Seznam
fn credentials(conn: &Connection) -> CommandResult<(String, String)> {
    let email = db::get_setting(conn, "email")
        .map_err(to_string_error)?
        .ok_or("Email credentials not configured")?;
    let password = secrets::get_password(&email).ok_or("Email credentials not configured")?;
    Ok((email, password))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendEmailRequest {
    to: String,
    subject: String,
    text: String,
    reply_to_id: Option<i64>,
    #[serde(default)]
    attachments: Vec<OutgoingAttachment>,
}

// A file picked from the computer, or an attachment of an email being forwarded
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum OutgoingAttachment {
    File { path: String },
    #[serde(rename_all = "camelCase")]
    Original { email_id: i64, index: usize },
}

// Seznam accepts emails up to about 30 MB; attachments grow by a third when sent
const MAX_ATTACHMENTS: u64 = 20 * 1024 * 1024;

#[tauri::command]
async fn send_email(state: State<'_, AppState>, email: SendEmailRequest) -> CommandResult<()> {
    let (from, password, in_reply_to) = {
        let conn = state.db.lock().unwrap();
        let (from, password) = credentials(&conn)?;
        let in_reply_to = match email.reply_to_id {
            Some(id) => conn
                .query_row("SELECT message_id FROM emails WHERE id = ?", [id], |r| r.get::<_, String>(0))
                .optional()
                .map_err(to_string_error)?,
            None => None,
        };
        (from, password, in_reply_to)
    };

    let mut attachments = Vec::new();
    for attachment in &email.attachments {
        attachments.push(match attachment {
            OutgoingAttachment::File { path } => {
                let path = std::path::Path::new(path);
                let contents = std::fs::read(path).map_err(|_| "Přiložený soubor se nepodařilo načíst.".to_string())?;
                let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                (name, contents)
            }
            OutgoingAttachment::Original { email_id, index } => load_attachment(&state, *email_id, *index)?,
        });
    }
    let total: u64 = attachments.iter().map(|(_, contents)| contents.len() as u64).sum();
    if total > MAX_ATTACHMENTS {
        return Err(format!(
            "Přílohy jsou dohromady moc velké ({} MB). Poslat jde nejvýš 20 MB, zkuste jich poslat méně.",
            total / 1024 / 1024
        ));
    }

    // Ensure a reply's subject starts with Re:
    let mut subject = email.subject;
    if in_reply_to.is_some() && !subject.starts_with("Re:") && !subject.starts_with("RE:") {
        subject = format!("Re: {subject}");
    }

    let sent = smtp::send_email(smtp::OutgoingEmail {
        from: from.clone(),
        password: password.clone(),
        to: email.to,
        subject,
        text: email.text,
        in_reply_to,
        attachments,
    })
    .await?;

    // The email is sent; saving the copy can finish in the background, then the sync shows it
    let sync_now = state.sync_now.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = imap::save_to_sent(&from, &password, &sent.message_id, &sent.raw).await {
            log::error!("Could not save the sent email to the Sent folder: {e}");
        }
        sync_now.notify_one();
    });
    Ok(())
}

#[tauri::command]
async fn test_connection(email: String, password: String) -> CommandResult<()> {
    // An empty password means "use the saved one"
    let password = if password.is_empty() {
        secrets::get_password(&email).ok_or("Vyplňte heslo")?
    } else {
        password
    };
    let mut session = imap::connect(&email, &password).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
async fn clear_emails(state: State<'_, AppState>) -> CommandResult<()> {
    let conn = state.db.lock().unwrap();
    // Delete all emails and reset sync progress, but keep credentials
    conn.execute("DELETE FROM emails", []).map_err(to_string_error)?;
    conn.execute(
        "DELETE FROM settings WHERE key LIKE 'sync_newest_uid%' OR key LIKE 'sync_oldest_uid%'
           OR key LIKE 'sync_uids_matched%' OR key LIKE 'sync_uidvalidity%'",
        [],
    )
    .map_err(to_string_error)?;
    log::info!("Emails cleared, credentials preserved");
    Ok(())
}

#[tauri::command]
async fn reprocess_emails(state: State<'_, AppState>) -> CommandResult<usize> {
    let db = state.db.clone();
    // Parsing every stored email takes a while; keep it off the async workers
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<i64> = {
            let conn = db.lock().unwrap();
            conn.prepare("SELECT email_id FROM email_raw")
                .map_err(to_string_error)?
                .query_map([], |r| r.get(0))
                .map_err(to_string_error)?
                .collect::<Result<_, _>>()
                .map_err(to_string_error)?
        };
        let mut processed = 0;
        // Load one raw email at a time instead of all of them into memory
        for id in ids {
            let conn = db.lock().unwrap();
            let raw: Vec<u8> = conn
                .query_row("SELECT raw FROM email_raw WHERE email_id = ?", [id], |r| r.get(0))
                .map_err(to_string_error)?;
            let Some(p) = parse::parse_raw_email(&raw) else {
                log::error!("Error reprocessing email {id}");
                continue;
            };
            conn.execute(
                "UPDATE emails SET
                   from_addr = ?, from_name = ?, to_addr = ?, subject = ?,
                   body_html = ?, body_text = ?, preview = ?
                 WHERE id = ?",
                params![p.from_addr, p.from_name, p.to_addr, p.subject, p.body_html, p.body_text, p.preview, id],
            )
            .map_err(to_string_error)?;
            processed += 1;
        }
        log::info!("Reprocessed {processed} emails");
        Ok(processed)
    })
    .await
    .map_err(to_string_error)?
}

// "Načíst zprávy": check for new mail now instead of waiting for the next round
#[tauri::command]
async fn sync_now(state: State<'_, AppState>) -> CommandResult<()> {
    state.sync_now.notify_one();
    Ok(())
}

// Links from emails open in the default browser; only web addresses are allowed
#[tauri::command]
async fn open_link(url: String) -> CommandResult<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Tento odkaz nelze otevřít".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(to_string_error)
}

fn load_attachment(state: &State<'_, AppState>, email_id: i64, index: usize) -> CommandResult<(String, Vec<u8>)> {
    let raw: Vec<u8> = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT raw FROM email_raw WHERE email_id = ?", [email_id], |r| r.get(0))
        .map_err(to_string_error)?;
    parse::attachment(&raw, index).ok_or_else(|| "Přílohu se nepodařilo najít".to_string())
}

// Open an attachment in its default program, from a copy in the app's cache folder
#[tauri::command]
async fn open_attachment(app: tauri::AppHandle, state: State<'_, AppState>, email_id: i64, index: usize) -> CommandResult<()> {
    let (file_name, contents) = load_attachment(&state, email_id, index)?;
    if parse::is_risky_to_open(&file_name) {
        return Err("Tuto přílohu nelze otevřít, mohla by spustit program.".into());
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(to_string_error)?
        .join("attachments")
        .join(format!("{email_id}-{index}"));
    std::fs::create_dir_all(&dir).map_err(to_string_error)?;
    let path = dir.join(&file_name);
    std::fs::write(&path, contents).map_err(to_string_error)?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(to_string_error)
}

// Save an attachment to the Downloads folder and show it there. Returns the saved file name.
#[tauri::command]
async fn save_attachment(app: tauri::AppHandle, state: State<'_, AppState>, email_id: i64, index: usize) -> CommandResult<String> {
    let (file_name, contents) = load_attachment(&state, email_id, index)?;
    let dir = app.path().download_dir().map_err(to_string_error)?;
    // Never overwrite: faktura.pdf, faktura (2).pdf, faktura (3).pdf, …
    let (stem, extension) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (file_name.clone(), String::new()),
    };
    let mut path = dir.join(&file_name);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){extension}"));
        n += 1;
    }
    std::fs::write(&path, contents).map_err(to_string_error)?;
    let _ = tauri_plugin_opener::reveal_item_in_dir(&path);
    Ok(path.file_name().unwrap_or_default().to_string_lossy().into_owned())
}

// New versions are published as GitHub releases (see .github/workflows/build.yml).
// Returns the new version number, if there is one.
#[tauri::command]
async fn check_for_update(app: AppHandle) -> CommandResult<Option<String>> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(to_string_error)?.check().await.map_err(|e| {
        log::info!("Could not check for updates: {e}");
        e.to_string()
    })?;
    Ok(update.map(|u| u.version))
}

// Download and install the new version, then start it
#[tauri::command]
async fn install_update(app: AppHandle) -> CommandResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(to_string_error)?
        .check()
        .await
        .map_err(|e| errors::describe(&e.to_string()))?
        .ok_or("Žádná nová verze není k dispozici.")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| {
        telemetry::report("update", &e.to_string());
        errors::describe(&e.to_string())
    })?;
    app.restart();
}

// Errors in the window (JavaScript errors, crashes of the interface)
#[tauri::command]
async fn report_ui_error(message: String) -> CommandResult<()> {
    telemetry::report("ui", &message);
    Ok(())
}

// Earlier versions kept the password in the database; move it to the system password store
fn move_password_out_of_database(conn: &Connection) {
    let (Ok(Some(email)), Ok(Some(password))) = (db::get_setting(conn, "email"), db::get_setting(conn, "password")) else {
        return;
    };
    match secrets::set_password(&email, &password) {
        Ok(()) => {
            let _ = conn.execute("DELETE FROM settings WHERE key = 'password'", []);
            log::info!("Moved the password to the system password store");
        }
        Err(e) => log::error!("{e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            telemetry::install_panic_hook(data_dir.clone());
            let conn = db::open(&data_dir.join("dadmail.db"))?;
            telemetry::configure(&conn);
            telemetry::send_crash_from_last_run(&data_dir);
            move_password_out_of_database(&conn);
            let db = Arc::new(Mutex::new(conn));
            log::info!("Database initialized at {}", data_dir.display());
            let sync_now = Arc::new(Notify::new());
            app.manage(AppState { db: db.clone(), sync_now: sync_now.clone() });

            // Fit the window to the screen; Windows laptops with display scaling
            // often have less than 1200x800 of usable space
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let area = monitor.work_area().size;
                    let scale = monitor.scale_factor();
                    let width = (area.width as f64 / scale).min(1200.0);
                    let height = (area.height as f64 / scale).min(800.0);
                    let _ = window.set_size(LogicalSize::new(width, height));
                    let _ = window.center();
                }
                let zoom = db::get_setting(&db.lock().unwrap(), "zoom").ok().flatten();
                if let Some(zoom) = zoom.and_then(|z| z.parse::<f64>().ok()) {
                    let _ = window.set_zoom(zoom);
                }
            }
            update_unread_count(app.handle(), &db.lock().unwrap());

            tauri::async_runtime::spawn(imap::run_sync_loop(app.handle().clone(), db, sync_now));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_emails,
            get_email,
            delete_email,
            restore_email,
            mark_unread,
            folder_counts,
            get_contacts,
            get_draft,
            save_draft,
            pick_files,
            get_settings,
            save_settings,
            send_email,
            test_connection,
            clear_emails,
            reprocess_emails,
            open_link,
            open_attachment,
            save_attachment,
            set_zoom,
            sync_now,
            report_ui_error,
            check_for_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DadMail");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_words_become_safe_prefix_queries() {
        assert_eq!(to_fts_query("  faktura  seznam "), "\"faktura\"* \"seznam\"*");
        assert_eq!(to_fts_query("\"foo AND (bar"), "\"\"\"foo\"* \"AND\"* \"(bar\"*");
        assert_eq!(to_fts_query("   "), "");
    }

    #[test]
    fn czech_plurals() {
        assert_eq!(czech_count(1, "nový email", "nové emaily", "nových emailů"), "1 nový email");
        assert_eq!(czech_count(3, "nový email", "nové emaily", "nových emailů"), "3 nové emaily");
        assert_eq!(czech_count(5, "nový email", "nové emaily", "nových emailů"), "5 nových emailů");
        assert_eq!(czech_count(0, "nový email", "nové emaily", "nových emailů"), "0 nových emailů");
    }

    #[test]
    fn search_finds_words_without_diacritics_and_by_prefix() {
        let dir = std::env::temp_dir().join(format!("dadmail-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("search.db");
        let _ = std::fs::remove_file(&path);
        let conn = db::open(&path).unwrap();
        conn.execute(
            "INSERT INTO emails (message_id, from_addr, from_name, to_addr, subject, body_text, date)
             VALUES ('<1@x>', 'a@b.cz', 'Banka', 'tata@seznam.cz', 'Výpis z účtu', 'Dobrý den, posíláme zprávu', 1)",
            [],
        )
        .unwrap();
        let hits = |q: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM emails_fts WHERE emails_fts MATCH ?",
                [to_fts_query(q)],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(hits("zpravu"), 1);
        assert_eq!(hits("vypis uctu"), 1);
        assert_eq!(hits("ban"), 1);
        assert_eq!(hits("faktura"), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
