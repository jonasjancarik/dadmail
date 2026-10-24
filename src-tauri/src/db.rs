use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::parse::make_preview;

// Same schema as the Electron app (src/main/db.js), so a database can move between them
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.pragma_update(None, "foreign_keys", "ON")?;
    db.pragma_update(None, "journal_mode", "WAL")?;

    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS emails (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE NOT NULL,
          from_addr TEXT NOT NULL,
          from_name TEXT NOT NULL,
          to_addr TEXT NOT NULL,
          subject TEXT NOT NULL,
          body_html TEXT,
          body_text TEXT,
          raw_content BLOB,
          date INTEGER NOT NULL,
          is_read INTEGER DEFAULT 0,
          is_deleted INTEGER DEFAULT 0,
          thread_id TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          preview TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_date ON emails(date DESC);
        CREATE INDEX IF NOT EXISTS idx_is_deleted ON emails(is_deleted);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        ",
    )?;

    // Databases created by older Electron versions have no preview column
    let has_preview: bool = db
        .prepare("SELECT 1 FROM pragma_table_info('emails') WHERE name = 'preview'")?
        .exists([])?;
    if !has_preview {
        db.execute("ALTER TABLE emails ADD COLUMN preview TEXT", [])?;
    }
    fill_missing_previews(&db)?;

    // Full-text search index, kept in sync with the emails table by triggers.
    // remove_diacritics lets "zprava" match "zpráva".
    let has_fts: bool = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'emails_fts'")?
        .exists([])?;
    db.execute_batch(
        "
        CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
          subject, from_name, from_addr, body_text,
          content='emails', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
          INSERT INTO emails_fts(rowid, subject, from_name, from_addr, body_text)
          VALUES (new.id, new.subject, new.from_name, new.from_addr, new.body_text);
        END;
        CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
          INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_addr, body_text)
          VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.body_text);
        END;
        CREATE TRIGGER IF NOT EXISTS emails_fts_update AFTER UPDATE OF subject, from_name, from_addr, body_text ON emails BEGIN
          INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_addr, body_text)
          VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.body_text);
          INSERT INTO emails_fts(rowid, subject, from_name, from_addr, body_text)
          VALUES (new.id, new.subject, new.from_name, new.from_addr, new.body_text);
        END;
        ",
    )?;
    if !has_fts {
        db.execute("INSERT INTO emails_fts(emails_fts) VALUES ('rebuild')", [])?;
        log::info!("Built search index");
    }

    Ok(db)
}

fn fill_missing_previews(db: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(i64, Option<String>)> = db
        .prepare("SELECT id, body_text FROM emails WHERE preview IS NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if rows.is_empty() {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    {
        let mut set_preview = tx.prepare("UPDATE emails SET preview = ? WHERE id = ?")?;
        for (id, body_text) in &rows {
            set_preview.execute(params![make_preview(body_text.as_deref().unwrap_or("")), id])?;
        }
    }
    tx.commit()?;
    log::info!("Filled previews for {} emails", rows.len());
    Ok(())
}

pub fn get_setting(db: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0))
        .optional()
}

pub fn set_setting(db: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [key, value],
    )?;
    Ok(())
}

pub fn get_settings(db: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    db.prepare("SELECT key, value FROM settings")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}
