import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initDatabase } from './db.js';
import { startImapSync } from './imap.js';
import { sendEmail } from './smtp.js';

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
  const stmt = db.prepare(`
    SELECT * FROM emails 
    WHERE is_deleted = 0 
    ${searchQuery ? 'AND (subject LIKE ? OR body_text LIKE ? OR from_name LIKE ?)' : ''}
    ORDER BY date DESC
  `);
  
  if (searchQuery) {
    const searchTerm = `%${searchQuery}%`;
    return stmt.all(searchTerm, searchTerm, searchTerm);
  }
  return stmt.all();
});

ipcMain.handle('get-email', async (event, id) => {
  if (!db) {
    return null;
  }
  const stmt = db.prepare('SELECT * FROM emails WHERE id = ?');
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
    const { simpleParser } = await import('mailparser');
    const { JSDOM } = await import('jsdom');
    const DOMPurify = (await import('dompurify')).default;
    const window = new JSDOM('').window;
    const purify = DOMPurify(window);
    
    // Get all emails with raw content
    const emails = db.prepare('SELECT id, raw_content FROM emails WHERE raw_content IS NOT NULL').all();
    let processed = 0;
    
    for (const email of emails) {
      try {
        const parsed = await simpleParser(email.raw_content);
        
        const from = parsed.from?.value?.[0] || {};
        const fromAddr = from.address || 'unknown@unknown';
        const fromName = from.name || fromAddr.split('@')[0];
        
        const to = parsed.to?.value?.[0] || {};
        const toAddr = to.address || 'unknown@unknown';
        
        const subject = parsed.subject || '(Bez předmětu)';
        let bodyText = parsed.text || '';
        let bodyHtml = parsed.html || '';
        
        if (bodyHtml) {
          bodyHtml = purify.sanitize(bodyHtml, {
            ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'img', 'hr', 'blockquote', 'pre', 'code'],
            ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'style'],
            ALLOW_DATA_ATTR: false,
          });
        }
        
        if (!bodyText && !bodyHtml) {
          bodyText = '(Email nemá textový obsah)';
        }
        
        db.prepare(`
          UPDATE emails SET 
            from_addr = ?, from_name = ?, to_addr = ?, subject = ?,
            body_html = ?, body_text = ?
          WHERE id = ?
        `).run(fromAddr, fromName, toAddr, subject, bodyHtml, bodyText, email.id);
        
        processed++;
      } catch (e) {
        console.error(`Error reprocessing email ${email.id}:`, e.message);
      }
    }
    
    console.log(`Reprocessed ${processed} emails`);
    return { success: true, processed };
  } catch (error) {
    console.error('Error reprocessing emails:', error);
    return { success: false, error: error.message, processed: 0 };
  }
});

