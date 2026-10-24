import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { makePreview } from './parse.js';

export function initDatabase() {
  // Create data directory if it doesn't exist
  const userDataPath = app.getPath('userData');
  const dataDir = join(userDataPath, 'data');
  mkdirSync(dataDir, { recursive: true });
  
  const dbPath = join(dataDir, 'dadmail.db');
  const db = new Database(dbPath);
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Create emails table
  db.exec(`
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
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  // Migration: Add raw_content column if it doesn't exist
  try {
    db.exec(`ALTER TABLE emails ADD COLUMN raw_content BLOB`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add preview column and fill it for existing emails
  try {
    db.exec(`ALTER TABLE emails ADD COLUMN preview TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  const missingPreviews = db.prepare('SELECT id, body_text FROM emails WHERE preview IS NULL').all();
  if (missingPreviews.length > 0) {
    const setPreview = db.prepare('UPDATE emails SET preview = ? WHERE id = ?');
    db.transaction(() => {
      for (const row of missingPreviews) {
        setPreview.run(makePreview(row.body_text), row.id);
      }
    })();
    console.log(`Filled previews for ${missingPreviews.length} emails`);
  }

  // Full-text search index, kept in sync with the emails table by triggers.
  // remove_diacritics lets "zprava" match "zpráva".
  const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'emails_fts'").get();
  db.exec(`
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
  `);
  if (!hasFts) {
    db.exec(`INSERT INTO emails_fts(emails_fts) VALUES ('rebuild')`);
    console.log('Built search index');
  }

  // Create index for faster lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_id ON emails(message_id);
    CREATE INDEX IF NOT EXISTS idx_date ON emails(date DESC);
    CREATE INDEX IF NOT EXISTS idx_is_deleted ON emails(is_deleted);
  `);
  
  // Create settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  
  return db;
}


