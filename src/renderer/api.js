import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// The UI runs in both the Electron and the Tauri app. Both backends are
// exposed through the Electron preload's shape (src/preload/preload.js).

// Run a Tauri command and report the result the way the Electron handlers do
async function withStatus(command, args, extra = (value) => ({})) {
  try {
    const value = await invoke(command, args);
    return { success: true, ...extra(value) };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Subscribe to a Tauri event; returns a function that removes the listener
function subscribe(event, callback) {
  const unlisten = listen(event, (e) => callback(e.payload));
  return () => unlisten.then((stop) => stop());
}

const tauriAPI = {
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
};

export const api = window.__TAURI_INTERNALS__ ? tauriAPI : window.electronAPI;
