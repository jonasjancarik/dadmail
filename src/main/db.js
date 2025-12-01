import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync } from 'fs';

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


