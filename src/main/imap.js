import { connect } from 'imap-simple';
import { parseRawEmail } from './parse.js';

let syncInterval = null;
let syncTimeout = null;
let isSyncing = false;

// Batch size for fetching emails
const BATCH_SIZE = 10;
// How many emails to fetch per sync cycle
const EMAILS_PER_SYNC = 50;

export function startImapSync(db, onUpdate) {
  // Clear any existing timers
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  
  // Start sync loop
  runSyncLoop(db, onUpdate);
}

async function runSyncLoop(db, onUpdate) {
  if (isSyncing) return;
  
  const result = await syncEmails(db, onUpdate);
  
  // If no credentials, wait and retry
  if (result?.noCredentials) {
    console.log('No credentials. Waiting 5 seconds before retry...');
    syncTimeout = setTimeout(() => {
      runSyncLoop(db, onUpdate);
    }, 5000);
    return;
  }
  
  // If error, wait before retry
  if (!result?.success) {
    console.log('Sync failed. Waiting 10 seconds before retry...');
    syncTimeout = setTimeout(() => {
      runSyncLoop(db, onUpdate);
    }, 10000);
    return;
  }
  
  // Check if we've completed historical sync
  const oldestSynced = getOldestSyncedSeq(db);
  const historyComplete = oldestSynced && oldestSynced <= 1;
  
  if (historyComplete) {
    // History complete - use 30 second interval for new email checks
    console.log('History sync complete. Checking for new emails every 30 seconds.');
    syncInterval = setInterval(() => {
      if (!isSyncing) {
        syncEmails(db, onUpdate);
      }
    }, 30000);
  } else {
    // History not complete - continue immediately (small delay to not overwhelm)
    console.log('History sync in progress. Continuing in 2 seconds...');
    syncTimeout = setTimeout(() => {
      runSyncLoop(db, onUpdate);
    }, 2000);
  }
}

export function getSyncStatus() {
  return { isSyncing };
}

// Get or set sync progress in settings
function getOldestSyncedSeq(db) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get('sync_oldest_seq');
  return row ? parseInt(row.value, 10) : null;
}

function setOldestSyncedSeq(db, seq) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  stmt.run('sync_oldest_seq', seq.toString());
}

function getNewestSyncedSeq(db) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get('sync_newest_seq');
  return row ? parseInt(row.value, 10) : null;
}

function setNewestSyncedSeq(db, seq) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  stmt.run('sync_newest_seq', seq.toString());
}

function getSyncFromDate(db) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get('sync_from_date');
  return row ? row.value : null;
}

async function syncEmails(db, onUpdate) {
  if (isSyncing) return;
  
  try {
    isSyncing = true;
    console.log('Starting sync...');
    
    if (onUpdate) {
      onUpdate(undefined, { status: 'syncing', message: 'Připojuji se k serveru...' });
    }
    
    // Get credentials from settings
    const settingsStmt = db.prepare('SELECT key, value FROM settings');
    const settingsRows = settingsStmt.all();
    const settings = {};
    settingsRows.forEach(row => {
      settings[row.key] = row.value;
    });
    
    if (!settings.email || !settings.password) {
      console.log('Email credentials not configured yet');
      if (onUpdate) {
        onUpdate(undefined, { status: 'idle', message: 'Čekám na nastavení přihlašovacích údajů' });
      }
      return { success: false, noCredentials: true };
    }
    
    const config = {
      imap: {
        user: settings.email,
        password: settings.password,
        host: 'imap.seznam.cz',
        port: 993,
        tls: true,
        authTimeout: 10000,
        connTimeout: 10000,
      },
    };
    
    let connection;
    try {
      console.log('Connecting to IMAP...');
      connection = await connect(config);
      console.log('Connected!');
    } catch (connError) {
      console.error('Connection error:', connError);
      if (onUpdate) {
        onUpdate(undefined, { status: 'error', message: 'Nelze se připojit k serveru' });
      }
      return { success: false, error: connError.message };
    }
    
    if (onUpdate) {
      onUpdate(undefined, { status: 'syncing', message: 'Kontroluji schránku...' });
    }
    
    // Open INBOX
    console.log('Opening INBOX...');
    const box = await connection.openBox('INBOX');
    const totalMessages = box.messages.total;
    console.log(`INBOX has ${totalMessages} messages`);
    
    if (totalMessages === 0) {
      await connection.end();
      if (onUpdate) {
        onUpdate(0, { status: 'success', message: 'Schránka je prázdná' });
      }
      return { success: true, newCount: 0, lowestSeqProcessed: 1 };
    }
    
    // Get all existing message_ids for quick lookup
    const existingStmt = db.prepare('SELECT message_id FROM emails');
    const existingIds = new Set(existingStmt.all().map(row => row.message_id));
    console.log(`Already have ${existingIds.size} emails in database`);
    
    // Get sync progress
    const oldestSyncedSeq = getOldestSyncedSeq(db);
    const newestSyncedSeq = getNewestSyncedSeq(db);
    const syncFromDate = getSyncFromDate(db);
    const syncFromTimestamp = syncFromDate ? new Date(syncFromDate).getTime() : null;
    
    console.log(`Sync progress: oldest=${oldestSyncedSeq}, newest=${newestSyncedSeq}, total=${totalMessages}`);
    
    // Determine what to sync:
    // 1. NEW emails: from (newestSyncedSeq + 1) to totalMessages - get ALL new arrivals
    // 2. HISTORICAL: continue backwards from oldestSyncedSeq
    
    // Check for new emails since last sync
    let newEmailsStart, newEmailsEnd;
    if (newestSyncedSeq && newestSyncedSeq < totalMessages) {
      // There are new emails since last sync
      newEmailsStart = newestSyncedSeq + 1;
      newEmailsEnd = totalMessages;
    } else if (!newestSyncedSeq) {
      // First sync - start with newest batch
      newEmailsStart = Math.max(1, totalMessages - EMAILS_PER_SYNC + 1);
      newEmailsEnd = totalMessages;
    } else {
      // No new emails
      newEmailsStart = 0;
      newEmailsEnd = 0;
    }
    
    // Historical sync - continue backwards from where we left off
    let historicalStart, historicalEnd;
    if (oldestSyncedSeq && oldestSyncedSeq > 1) {
      // Continue from where we left off
      historicalEnd = oldestSyncedSeq - 1;
      historicalStart = Math.max(1, historicalEnd - EMAILS_PER_SYNC + 1);
    } else if (!oldestSyncedSeq && newestSyncedSeq && newEmailsStart > 1) {
      // We've synced newest but not gone backwards yet
      // Go backwards from where the new emails started
      historicalEnd = newEmailsStart - 1;
      historicalStart = Math.max(1, historicalEnd - EMAILS_PER_SYNC + 1);
    } else if (!oldestSyncedSeq && !newestSyncedSeq) {
      // First sync - don't do historical yet, just get newest first
      historicalStart = 0;
      historicalEnd = 0;
    } else {
      // We've synced everything or edge case
      historicalStart = 0;
      historicalEnd = 0;
    }
    
    console.log(`Sync plan: new emails ${newEmailsStart}:${newEmailsEnd}, historical ${historicalStart}:${historicalEnd}`);
    
    const imap = connection.imap;
    let newCount = 0;

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO emails (
        message_id, from_addr, from_name, to_addr, subject,
        body_html, body_text, preview, raw_content, date, thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBatch = db.transaction((rows) => {
      for (const row of rows) {
        if (insertStmt.run(...row).changes > 0) {
          newCount++;
        }
      }
    });
    let reachedDateLimit = false;
    let lowestSeqProcessed = oldestSyncedSeq || totalMessages + 1;
    
    // Function to fetch a range of messages
    async function fetchRange(startSeq, endSeq, label) {
      if (startSeq > endSeq || startSeq < 1) return;
      
      console.log(`Fetching ${label}: ${startSeq}:${endSeq}`);
      if (onUpdate) {
        onUpdate(undefined, { status: 'syncing', message: `Kontroluji ${label}...` });
      }
      
      // Fetch headers first
      const headerResults = await new Promise((resolve, reject) => {
        const results = [];
        const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, {
          bodies: ['HEADER.FIELDS (MESSAGE-ID DATE)'],
          struct: false,
        });
        
        fetch.on('message', (msg, seqno) => {
          let uid = null;
          let header = '';
          
          msg.on('body', (stream, info) => {
            let buffer = '';
            stream.on('data', (chunk) => {
              buffer += chunk.toString('utf8');
            });
            stream.once('end', () => {
              header = buffer;
            });
          });
          
          msg.once('attributes', (attrs) => {
            uid = attrs.uid;
          });
          
          msg.once('end', () => {
            results.push({ uid, header, seqno });
          });
        });
        
        fetch.once('error', reject);
        fetch.once('end', () => resolve(results));
      });
      
      // Filter to only new emails and sort by seqno descending (newest first)
      let newMessages = [];
      for (const msg of headerResults) {
        const { uid, header, seqno } = msg;
        
        // Extract message-id
        const messageIdMatch = header.match(/Message-ID:\s*<?([^>\s]+)>?/i);
        const messageId = messageIdMatch ? messageIdMatch[1] : `uid-${uid}`;
        
        // Extract date
        const dateMatch = header.match(/Date:\s*(.+)/i);
        const emailDate = dateMatch ? new Date(dateMatch[1].trim()).getTime() : Date.now();
        
        // Check date limit
        if (syncFromTimestamp && emailDate < syncFromTimestamp) {
          console.log(`Reached date limit at seqno ${seqno}`);
          reachedDateLimit = true;
          continue;
        }
        
        if (!existingIds.has(messageId) && !existingIds.has(`<${messageId}>`)) {
          newMessages.push({ uid, messageId, seqno, emailDate });
        }
        
        // Track lowest sequence processed
        if (seqno < lowestSeqProcessed) {
          lowestSeqProcessed = seqno;
        }
      }
      
      // Sort newest first
      newMessages.sort((a, b) => b.seqno - a.seqno);
      
      if (newMessages.length === 0) {
        console.log(`No new emails in range ${startSeq}:${endSeq}`);
        return;
      }
      
      console.log(`Found ${newMessages.length} new emails to fetch`);
      
      // Process in batches
      for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
        const batch = newMessages.slice(i, i + BATCH_SIZE);
        const uids = batch.map(m => m.uid);
        
        const progress = Math.round(((i + BATCH_SIZE) / newMessages.length) * 100);
        if (onUpdate) {
          onUpdate(newCount, { 
            status: 'syncing', 
            message: `Stahuji ${Math.min(i + BATCH_SIZE, newMessages.length)}/${newMessages.length} emailů...`,
            progress: Math.min(progress, 100)
          });
        }
        
        try {
          // Fetch full raw email for proper parsing with mailparser
          const fetchResults = await new Promise((resolve, reject) => {
            const results = [];
            const fetch = imap.fetch(uids, {
              bodies: '',  // Fetch entire raw email
              struct: false,
            });
            
            fetch.on('message', (msg, seqno) => {
              const email = { raw: '', uid: null };
              
              msg.on('body', (stream, info) => {
                const chunks = [];
                stream.on('data', (chunk) => {
                  chunks.push(chunk);
                });
                stream.once('end', () => {
                  email.raw = Buffer.concat(chunks);
                });
              });
              
              msg.once('attributes', (attrs) => {
                email.uid = attrs.uid;
              });
              
              msg.once('end', () => {
                results.push(email);
              });
            });
            
            fetch.once('error', reject);
            fetch.once('end', () => resolve(results));
          });
          
          // Parse the whole batch first, then write it in a single transaction
          const rows = [];
          for (const msg of fetchResults) {
            try {
              if (!msg.raw || msg.raw.length === 0) continue;

              const uid = msg.uid;
              const batchItem = batch.find(b => b.uid === uid);
              const p = await parseRawEmail(msg.raw);

              rows.push([
                p.messageId || batchItem?.messageId || `uid-${uid}`,
                p.fromAddr,
                p.fromName,
                p.toAddr,
                p.subject,
                p.bodyHtml,
                p.bodyText,
                p.preview,
                msg.raw,  // Store raw email content
                p.date ?? Math.floor(Date.now() / 1000),
                p.inReplyTo,
              ]);
            } catch (parseError) {
              console.error('Error parsing email:', parseError.message);
            }
          }

          insertBatch(rows);
          
          // Update UI after each batch
          if (onUpdate && newCount > 0) {
            onUpdate(newCount, { 
              status: 'syncing', 
              message: `Načteno ${newCount} emailů...`,
              progress: Math.min(progress, 100)
            });
          }
          
        } catch (batchError) {
          console.error('Error fetching batch:', batchError.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    // 1. Fetch new emails first (all emails since last sync)
    if (newEmailsStart > 0 && newEmailsEnd > 0) {
      await fetchRange(newEmailsStart, newEmailsEnd, 'nové emaily');
    }
    
    // 2. Continue historical sync if not done and not reached date limit
    if (historicalStart > 0 && historicalEnd > 0 && !reachedDateLimit) {
      await fetchRange(historicalStart, historicalEnd, 'starší emaily');
    }
    
    // Save sync progress - track both newest and oldest
    // Update newest synced seq to current total
    if (newEmailsEnd > 0) {
      setNewestSyncedSeq(db, totalMessages);
      console.log(`Saved newest sync progress: ${totalMessages}`);
    }
    
    // Update oldest synced seq if we went further back
    if (lowestSeqProcessed < (oldestSyncedSeq || totalMessages + 1)) {
      setOldestSyncedSeq(db, lowestSeqProcessed);
      console.log(`Saved oldest sync progress: ${lowestSeqProcessed}`);
    }
    
    await connection.end();
    console.log(`Sync complete. Added ${newCount} new emails.`);
    
    // Determine status message
    let statusMessage;
    if (reachedDateLimit) {
      statusMessage = `Hotovo! Načteno ${newCount} emailů (dosaženo datového limitu)`;
    } else if (lowestSeqProcessed <= 1) {
      statusMessage = `Hotovo! Všechny emaily synchronizovány`;
    } else {
      const remaining = lowestSeqProcessed - 1;
      statusMessage = newCount > 0 
        ? `Načteno ${newCount} emailů (zbývá ${remaining} starších)`
        : 'Žádné nové emaily';
    }
    
    if (onUpdate) {
      onUpdate(newCount, { status: 'success', message: statusMessage });
    }
    
    return { success: true, newCount, lowestSeqProcessed };
    
  } catch (error) {
    console.error('IMAP sync error:', error);
    if (onUpdate) {
      onUpdate(undefined, { status: 'error', message: `Chyba: ${error.message}` });
    }
    return { success: false, error: error.message };
  } finally {
    isSyncing = false;
    // Only clear status if history is complete (otherwise we're continuing)
    const oldestSynced = getOldestSyncedSeq(db);
    const historyComplete = oldestSynced && oldestSynced <= 1;
    if (historyComplete) {
      setTimeout(() => {
        if (onUpdate) {
          onUpdate(undefined, { status: 'idle', message: '' });
        }
      }, 3000);
    }
  }
}

export function stopImapSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
}
