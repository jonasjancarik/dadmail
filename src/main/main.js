import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDatabase } from './db.js';
import { startImapSync } from './imap.js';
import { sendEmail } from './smtp.js';
import { parseRawEmail } from './parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow;
let db;

function createWindow() {
  // Fit the window to the screen; Windows laptops with display scaling
  // often have less than 1200x800 of usable space
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1200, screenWidth),
    height: Math.min(800, screenHeight),
    minWidth: 800,
    minHeight: 500,
    show: false, // Don't show until ready
    webPreferences: {
      preload: join(__dirname, './preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Show window immediately
  mainWindow.show();
  mainWindow.focus();

  // electron-forge's Vite plugin defines these: the dev server URL in development,
  // the bundled renderer folder name in packaged builds
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  
  // Open dev tools in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
  
  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // Log renderer errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });
}

app.whenReady().then(async () => {
  try {
    // Initialize database
    db = initDatabase();
    console.log('Database initialized');
    
    createWindow();
    console.log('Window created');
  } catch (error) {
    console.error('Error during app initialization:', error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Start IMAP sync after a short delay
  setTimeout(() => {
    startImapSync(db, (emailCount, status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (status) {
          mainWindow.webContents.send('sync-status', status);
        }
        if (emailCount !== undefined) {
          mainWindow.webContents.send('emails-updated', emailCount);
        }
      }
    });
  }, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers
ipcMain.handle('get-emails', async (event, searchQuery = '') => {
  if (!db) {
    return [];
  }
  // Only the columns the list shows; full bodies are loaded by get-email when opened
  const listColumns = 'e.id, e.from_addr, e.from_name, e.subject, e.preview, e.date, e.is_read';
  const ftsQuery = toFtsQuery(searchQuery);

  if (ftsQuery) {
    return db.prepare(`
      SELECT ${listColumns} FROM emails_fts
      JOIN emails e ON e.id = emails_fts.rowid
      WHERE emails_fts MATCH ? AND e.is_deleted = 0
      ORDER BY e.date DESC
    `).all(ftsQuery);
  }
  return db.prepare(`
    SELECT ${listColumns} FROM emails e
    WHERE e.is_deleted = 0
    ORDER BY e.date DESC
  `).all();
});

// Turn what the user typed into an FTS5 query: every word must match,
// each as a prefix, with FTS syntax characters treated as plain text
function toFtsQuery(searchQuery) {
  const words = (searchQuery || '').trim().split(/\s+/).filter(Boolean);
  return words.map(word => `"${word.replace(/"/g, '""')}"*`).join(' ');
}

ipcMain.handle('get-email', async (event, id) => {
  if (!db) {
    return null;
  }
  const stmt = db.prepare(`
    SELECT id, message_id, from_addr, from_name, to_addr, subject,
      body_html, body_text, date, is_read, thread_id
    FROM emails WHERE id = ?
  `);
  const email = stmt.get(id);
  
  // Mark as read
  if (email && !email.is_read) {
    const updateStmt = db.prepare('UPDATE emails SET is_read = 1 WHERE id = ?');
    updateStmt.run(id);
  }
  
  return email;
});

ipcMain.handle('delete-email', async (event, id) => {
  if (!db) {
    return { success: false };
  }
  const stmt = db.prepare('UPDATE emails SET is_deleted = 1 WHERE id = ?');
  stmt.run(id);
  return { success: true };
});

ipcMain.handle('get-settings', async () => {
  if (!db) {
    return {};
  }
  const stmt = db.prepare('SELECT key, value FROM settings');
  const rows = stmt.all();
  const settings = {};
  rows.forEach(row => {
    settings[row.key] = row.value;
  });
  return settings;
});

ipcMain.handle('save-settings', async (event, settings) => {
  if (!db) {
    return { success: false };
  }
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  Object.entries(settings).forEach(([key, value]) => {
    stmt.run(key, value);
  });
  return { success: true };
});

ipcMain.handle('send-email', async (event, { to, subject, text, replyToId }) => {
  try {
    await sendEmail(db, { to, subject, text, replyToId });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('test-connection', async (event, { email, password }) => {
  try {
    const { connect } = await import('imap-simple');
    const config = {
      imap: {
        user: email,
        password: password,
        host: 'imap.seznam.cz',
        port: 993,
        tls: true,
        authTimeout: 10000,
      },
    };
    
    const connection = await connect(config);
    await connection.end();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-emails', async () => {
  if (!db) {
    return { success: false };
  }
  try {
    // Delete all emails
    db.prepare('DELETE FROM emails').run();
    // Reset sync progress (but keep credentials)
    db.prepare("DELETE FROM settings WHERE key IN ('sync_oldest_seq', 'sync_newest_seq')").run();
    console.log('Emails cleared, credentials preserved');
    return { success: true };
  } catch (error) {
    console.error('Error clearing emails:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('reprocess-emails', async () => {
  if (!db) {
    return { success: false, processed: 0 };
  }
  try {
    const ids = db.prepare('SELECT id FROM emails WHERE raw_content IS NOT NULL').all();
    const getRaw = db.prepare('SELECT raw_content FROM emails WHERE id = ?');
    const updateStmt = db.prepare(`
      UPDATE emails SET
        from_addr = ?, from_name = ?, to_addr = ?, subject = ?,
        body_html = ?, body_text = ?, preview = ?
      WHERE id = ?
    `);
    let processed = 0;

    // Load one raw email at a time instead of all of them into memory
    for (const { id } of ids) {
      try {
        const p = await parseRawEmail(getRaw.get(id).raw_content);
        updateStmt.run(p.fromAddr, p.fromName, p.toAddr, p.subject, p.bodyHtml, p.bodyText, p.preview, id);
        processed++;
      } catch (e) {
        console.error(`Error reprocessing email ${id}:`, e.message);
      }
    }
    
    console.log(`Reprocessed ${processed} emails`);
    return { success: true, processed };
  } catch (error) {
    console.error('Error reprocessing emails:', error);
    return { success: false, error: error.message, processed: 0 };
  }
});

