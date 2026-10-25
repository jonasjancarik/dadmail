use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::parse::make_preview;

use crate::folders::FolderInfo;

const EMAILS_TABLE: &str = "
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Where DadMail shows the email: inbox, sent or trash
  folder TEXT NOT NULL DEFAULT 'inbox',
  -- Where it is on the server. Differs from folder while a move made in DadMail waits to be sent.
  server_folder TEXT NOT NULL DEFAULT 'inbox',
  -- IMAP UID in server_folder; NULL until known (after a move the server assigns a new one)
  uid INTEGER,
  message_id TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT,
  body_text TEXT,
  raw_content BLOB, -- no longer used: original emails are in email_raw
  date INTEGER NOT NULL,
  is_read INTEGER DEFAULT 0,
  thread_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  preview TEXT,
  -- 'read' or 'unread': a change made in DadMail, not yet sent to the server
  pending_action TEXT,
  -- The same email can be in two folders (e.g. sent to yourself)
  UNIQUE(folder, message_id)
";

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.pragma_update(None, "foreign_keys", "ON")?;
    db.pragma_update(None, "journal_mode", "WAL")?;

    db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS emails ({EMAILS_TABLE});"))?;
    db.execute_batch(
        "
        -- The original emails, kept apart so listing emails doesn't read through them
        CREATE TABLE IF NOT EXISTS email_raw (
          email_id INTEGER PRIMARY KEY,
          raw BLOB NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS email_raw_delete AFTER DELETE ON emails BEGIN
          DELETE FROM email_raw WHERE email_id = old.id;
        END;
        -- The server's folders, refreshed on every sync (see folders.rs)
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          server_name TEXT NOT NULL,
          role TEXT,
          label TEXT NOT NULL,
          depth INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL
        );
        -- Until the first sync, the folders every Seznam account has
        INSERT OR IGNORE INTO folders (id, server_name, role, label, position) VALUES
          ('inbox', 'INBOX', 'inbox', 'Doručená pošta', 0),
          ('sent', 'sent', 'sent', 'Odeslaná pošta', 1),
          ('trash', 'trash', 'trash', 'Koš', 2);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        ",
    )?;

    // Columns added to the Electron-era table, needed before it can be converted below
    for (column, definition) in [
        ("preview", "TEXT"),
        ("uid", "INTEGER"),
        ("pending_action", "TEXT"),
    ] {
        let exists: bool = db
            .prepare("SELECT 1 FROM pragma_table_info('emails') WHERE name = ?")?
            .exists([column])?;
        if !exists {
            db.execute(&format!("ALTER TABLE emails ADD COLUMN {column} {definition}"), [])?;
        }
    }
    add_folders(&db)?;
    db.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_folder_date ON emails(folder, date DESC);
        CREATE INDEX IF NOT EXISTS idx_server_uid ON emails(server_folder, uid);
        ",
    )?;
    move_raw_emails_out(&db)?;
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

    // Fold the write-ahead log back into the database file, so it doesn't stay large
    // after big changes such as the VACUUM above
    db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;

    Ok(db)
}

// Earlier versions only knew the inbox and kept Message-IDs unique across everything.
// Rebuild the table once with folders, keeping every id (search index and email_raw use them).
fn add_folders(db: &Connection) -> rusqlite::Result<()> {
    let has_folder: bool = db
        .prepare("SELECT 1 FROM pragma_table_info('emails') WHERE name = 'folder'")?
        .exists([])?;
    if has_folder {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    tx.execute_batch(&format!("CREATE TABLE emails_with_folders ({EMAILS_TABLE});"))?;
    // Emails that were deleted earlier only hid locally; the trash folder will bring them back.
    // A delete that had not reached the server yet becomes a move to the trash.
    let copied = tx.execute(
        "INSERT INTO emails_with_folders (
           id, folder, server_folder, uid, message_id, from_addr, from_name, to_addr, subject,
           body_html, body_text, date, is_read, thread_id, created_at, preview, pending_action
         )
         SELECT id,
           CASE WHEN pending_action = 'delete' THEN 'trash' ELSE 'inbox' END,
           'inbox', uid, message_id, from_addr, from_name, to_addr, subject,
           body_html, body_text, date, is_read, thread_id, created_at, preview,
           CASE WHEN pending_action = 'read' THEN 'read' END
         FROM emails
         WHERE is_deleted = 0 OR (pending_action = 'delete' AND uid IS NOT NULL)",
        [],
    )?;
    tx.execute_batch(
        "
        DELETE FROM email_raw WHERE email_id NOT IN (SELECT id FROM emails_with_folders);
        DROP TABLE emails;
        ALTER TABLE emails_with_folders RENAME TO emails;
        ",
    )?;
    // Rebuilt below with the new table
    tx.execute_batch("DROP TABLE IF EXISTS emails_fts;")?;
    tx.commit()?;
    log::info!("Added folders to {copied} emails");
    Ok(())
}

// Earlier versions kept the original emails in emails.raw_content; move them to email_raw
// and shrink the file once
fn move_raw_emails_out(db: &Connection) -> rusqlite::Result<()> {
    let has_raw: bool = db
        .prepare("SELECT 1 FROM emails WHERE raw_content IS NOT NULL LIMIT 1")?
        .exists([])?;
    if !has_raw {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    let moved = tx.execute(
        "INSERT OR IGNORE INTO email_raw (email_id, raw)
         SELECT id, raw_content FROM emails WHERE raw_content IS NOT NULL",
        [],
    )?;
    tx.execute("UPDATE emails SET raw_content = NULL WHERE raw_content IS NOT NULL", [])?;
    tx.commit()?;
    db.execute_batch("VACUUM")?;
    log::info!("Moved {moved} original emails to their own table");
    Ok(())
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

// Replace the folder list with what the server has now. Emails in folders that are gone
// (deleted or renamed on the server) are removed; a renamed folder downloads them again.
pub fn save_folders(db: &Connection, folders: &[FolderInfo]) -> rusqlite::Result<usize> {
    let tx = db.unchecked_transaction()?;
    tx.execute("DELETE FROM folders", [])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO folders (id, server_name, role, label, depth, position) VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        for f in folders {
            insert.execute(params![f.id, f.server_name, f.role, f.label, f.depth as i64, f.position])?;
        }
    }
    let removed = tx.execute(
        "DELETE FROM emails WHERE folder NOT IN (SELECT id FROM folders) OR server_folder NOT IN (SELECT id FROM folders)",
        [],
    )?;
    tx.commit()?;
    Ok(removed)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_inbox_only_database_gets_folders() {
        let dir = std::env::temp_dir().join(format!("dadmail-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        let _ = std::fs::remove_file(&path);
        {
            // The table as the previous version left it
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE emails (
                   id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE NOT NULL,
                   from_addr TEXT NOT NULL, from_name TEXT NOT NULL, to_addr TEXT NOT NULL,
                   subject TEXT NOT NULL, body_html TEXT, body_text TEXT, raw_content BLOB,
                   date INTEGER NOT NULL, is_read INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0,
                   thread_id TEXT, created_at INTEGER, preview TEXT, uid INTEGER, pending_action TEXT
                 );
                 CREATE TABLE email_raw (email_id INTEGER PRIMARY KEY, raw BLOB NOT NULL);
                 INSERT INTO emails (id, message_id, from_addr, from_name, to_addr, subject, body_text, date, is_read, uid, pending_action, preview)
                 VALUES (1, '<a@x>', 'a@b.cz', 'Anna', 't@s.cz', 'Fotky z chaty', 'ahoj', 1, 1, 10, 'read', 'ahoj'),
                        (2, '<b@x>', 'b@b.cz', 'Bob', 't@s.cz', 'Smazaný', 'pa', 2, 0, NULL, NULL, 'pa'),
                        (3, '<c@x>', 'c@b.cz', 'Cyril', 't@s.cz', 'Ke smazání', 'x', 3, 0, 12, 'delete', 'x');
                 UPDATE emails SET is_deleted = 1 WHERE id IN (2, 3);
                 INSERT INTO email_raw VALUES (1, x'01'), (2, x'02'), (3, x'03');",
            )
            .unwrap();
        }

        let db = open(&path).unwrap();
        let rows: Vec<(i64, String, String, Option<String>)> = db
            .prepare("SELECT id, folder, server_folder, pending_action FROM emails ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (1, "inbox".into(), "inbox".into(), Some("read".into())),
                // A delete that never reached the server becomes a move to the trash
                (3, "trash".into(), "inbox".into(), None),
            ]
        );
        let raw_ids: Vec<i64> = db
            .prepare("SELECT email_id FROM email_raw ORDER BY email_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(raw_ids, vec![1, 3]);
        let found: i64 = db
            .query_row("SELECT count(*) FROM emails_fts WHERE emails_fts MATCH '\"chaty\"*'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(found, 1);

        // Opening again changes nothing
        drop(db);
        let db = open(&path).unwrap();
        let count: i64 = db.query_row("SELECT count(*) FROM emails", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
