mod db;
mod imap;
mod parse;
mod smtp;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, Manager, State};

struct AppState {
    db: Arc<Mutex<Connection>>,
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
    subject: String,
    preview: Option<String>,
    date: i64,
    is_read: i64,
}

#[derive(Serialize)]
struct Email {
    id: i64,
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
async fn get_emails(state: State<'_, AppState>, search_query: Option<String>) -> CommandResult<Vec<EmailListItem>> {
    let started = std::time::Instant::now();
    let conn = state.db.lock().unwrap();
    let fts_query = to_fts_query(search_query.as_deref().unwrap_or(""));
    let columns = "e.id, e.from_addr, e.from_name, e.subject, e.preview, e.date, e.is_read";
    let (sql, args): (String, Vec<String>) = if fts_query.is_empty() {
        (
            format!("SELECT {columns} FROM emails e WHERE e.is_deleted = 0 ORDER BY e.date DESC"),
            vec![],
        )
    } else {
        (
            format!(
                "SELECT {columns} FROM emails_fts
                 JOIN emails e ON e.id = emails_fts.rowid
                 WHERE emails_fts MATCH ? AND e.is_deleted = 0
                 ORDER BY e.date DESC"
            ),
            vec![fts_query],
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
                subject: r.get(3)?,
                preview: r.get(4)?,
                date: r.get(5)?,
                is_read: r.get(6)?,
            })
        })
        .map_err(to_string_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string_error)?;
    log::info!("get_emails: {} rows in {:?}", emails.len(), started.elapsed());
    Ok(emails)
}

#[tauri::command]
async fn get_email(state: State<'_, AppState>, id: i64) -> CommandResult<Option<Email>> {
    let conn = state.db.lock().unwrap();
    let email = conn
        .query_row(
            "SELECT id, message_id, from_addr, from_name, to_addr, subject,
               body_html, body_text, date, is_read, thread_id
             FROM emails WHERE id = ?",
            [id],
            |r| {
                Ok(Email {
                    id: r.get(0)?,
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
                })
            },
        )
        .optional()
        .map_err(to_string_error)?;

    // Mark as read
    if email.as_ref().is_some_and(|e| e.is_read == 0) {
        conn.execute("UPDATE emails SET is_read = 1 WHERE id = ?", [id])
            .map_err(to_string_error)?;
    }
    Ok(email)
}

#[tauri::command]
async fn delete_email(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("UPDATE emails SET is_deleted = 1 WHERE id = ?", [id])
        .map_err(to_string_error)?;
    Ok(())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> CommandResult<HashMap<String, String>> {
    db::get_settings(&state.db.lock().unwrap()).map_err(to_string_error)
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, settings: HashMap<String, String>) -> CommandResult<()> {
    let conn = state.db.lock().unwrap();
    for (key, value) in &settings {
        db::set_setting(&conn, key, value).map_err(to_string_error)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendEmailRequest {
    to: String,
    subject: String,
    text: String,
    reply_to_id: Option<i64>,
}

#[tauri::command]
async fn send_email(state: State<'_, AppState>, email: SendEmailRequest) -> CommandResult<()> {
    let (from, password, in_reply_to) = {
        let conn = state.db.lock().unwrap();
        let settings = db::get_settings(&conn).map_err(to_string_error)?;
        let (Some(from), Some(password)) = (settings.get("email"), settings.get("password")) else {
            return Err("Email credentials not configured".into());
        };
        let in_reply_to = match email.reply_to_id {
            Some(id) => conn
                .query_row("SELECT message_id FROM emails WHERE id = ?", [id], |r| r.get::<_, String>(0))
                .optional()
                .map_err(to_string_error)?,
            None => None,
        };
        (from.clone(), password.clone(), in_reply_to)
    };

    // Ensure a reply's subject starts with Re:
    let mut subject = email.subject;
    if in_reply_to.is_some() && !subject.starts_with("Re:") && !subject.starts_with("RE:") {
        subject = format!("Re: {subject}");
    }

    smtp::send_email(smtp::OutgoingEmail {
        from,
        password,
        to: email.to,
        subject,
        text: email.text,
        in_reply_to,
    })
    .await
}

#[tauri::command]
async fn test_connection(email: String, password: String) -> CommandResult<()> {
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
        "DELETE FROM settings WHERE key IN ('sync_newest_uid', 'sync_oldest_uid')",
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
            conn.prepare("SELECT id FROM emails WHERE raw_content IS NOT NULL")
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
                .query_row("SELECT raw_content FROM emails WHERE id = ?", [id], |r| r.get(0))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Arc::new(Mutex::new(db::open(&data_dir.join("dadmail.db"))?));
            log::info!("Database initialized at {}", data_dir.display());
            app.manage(AppState { db: db.clone() });

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
            }

            tauri::async_runtime::spawn(imap::run_sync_loop(app.handle().clone(), db));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_emails,
            get_email,
            delete_email,
            get_settings,
            save_settings,
            send_email,
            test_connection,
            clear_emails,
            reprocess_emails,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DadMail");
}
