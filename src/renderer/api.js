import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Calls into the Rust backend (src-tauri/src/lib.rs)

// Run a command and report whether it worked, for actions that show a success or error message
async function withStatus(command, args, extra = (value) => ({})) {
  try {
    const value = await invoke(command, args);
    return { success: true, ...extra(value) };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Subscribe to a backend event; returns a function that removes the listener
function subscribe(event, callback) {
  const unlisten = listen(event, (e) => callback(e.payload));
  return () => unlisten.then((stop) => stop());
}

export const api = {
  getEmails: (searchQuery) => invoke('get_emails', { searchQuery }),
  getEmail: (id) => invoke('get_email', { id }),
  deleteEmail: (id) => withStatus('delete_email', { id }),
  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => withStatus('save_settings', { settings }),
  sendEmail: (email) => withStatus('send_email', { email }),
  testConnection: ({ email, password }) => withStatus('test_connection', { email, password }),
  onEmailsUpdated: (callback) => subscribe('emails-updated', callback),
  onSyncStatus: (callback) => subscribe('sync-status', callback),
  clearEmails: () => withStatus('clear_emails'),
  reprocessEmails: () => withStatus('reprocess_emails', {}, (processed) => ({ processed })),
  openLink: (url) => withStatus('open_link', { url }),
  openAttachment: (emailId, index) => withStatus('open_attachment', { emailId, index }),
  saveAttachment: (emailId, index) => withStatus('save_attachment', { emailId, index }, (fileName) => ({ fileName })),
};
