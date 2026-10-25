import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createPreviewApi } from './previewApi';

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

const tauriApi = {
  getEmails: (folder, searchQuery) => invoke('get_emails', { folder, searchQuery }),
  getEmail: (id) => invoke('get_email', { id }),
  deleteEmail: (id) => withStatus('delete_email', { id }),
  restoreEmail: (id) => withStatus('restore_email', { id }),
  markUnread: (id) => withStatus('mark_unread', { id }),
  getFolders: () => invoke('get_folders'),
  getContacts: () => invoke('get_contacts').catch(() => []),
  getDraft: async () => {
    const draft = await invoke('get_draft').catch(() => null);
    return draft ? JSON.parse(draft) : null;
  },
  saveDraft: (draft) => invoke('save_draft', { draft: draft ? JSON.stringify(draft) : null }).catch(() => {}),
  pickFiles: () => invoke('pick_files').catch(() => []),
  getSettings: () => invoke('get_settings'),
  saveSettings: (settings) => withStatus('save_settings', { settings }),
  sendEmail: (email) => withStatus('send_email', { email }),
  testConnection: ({ email, password }) => withStatus('test_connection', { email, password }),
  onEmailsUpdated: (callback) => subscribe('emails-updated', callback),
  onSyncStatus: (callback) => subscribe('sync-status', callback),
  clearEmails: () => withStatus('clear_emails'),
  reprocessEmails: () => withStatus('reprocess_emails', {}, (processed) => ({ processed })),
  openLink: (url) => withStatus('open_link', { url }),
  setZoom: (zoom) => invoke('set_zoom', { zoom }),
  syncNow: () => invoke('sync_now'),
  reportError: (message) => invoke('report_ui_error', { message: String(message) }).catch(() => {}),
  checkForUpdate: () => invoke('check_for_update').catch(() => null),
  installUpdate: () => withStatus('install_update'),
  openAttachment: (emailId, index) => withStatus('open_attachment', { emailId, index }),
  saveAttachment: (emailId, index) => withStatus('save_attachment', { emailId, index }, (fileName) => ({ fileName })),
};

// In development, the UI can also be opened in a normal browser with sample emails
export const api = import.meta.env.DEV && !window.__TAURI_INTERNALS__ ? createPreviewApi() : tauriApi;
