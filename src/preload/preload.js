import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getEmails: (searchQuery) => ipcRenderer.invoke('get-emails', searchQuery),
  getEmail: (id) => ipcRenderer.invoke('get-email', id),
  deleteEmail: (id) => ipcRenderer.invoke('delete-email', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  sendEmail: (emailData) => ipcRenderer.invoke('send-email', emailData),
  testConnection: (credentials) => ipcRenderer.invoke('test-connection', credentials),
  // These return a function that removes the listener
  onEmailsUpdated: (callback) => {
    const listener = (event, count) => callback(count);
    ipcRenderer.on('emails-updated', listener);
    return () => ipcRenderer.removeListener('emails-updated', listener);
  },
  onSyncStatus: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on('sync-status', listener);
    return () => ipcRenderer.removeListener('sync-status', listener);
  },
  clearEmails: () => ipcRenderer.invoke('clear-emails'),
  reprocessEmails: () => ipcRenderer.invoke('reprocess-emails'),
});


