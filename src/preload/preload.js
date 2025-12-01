import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getEmails: (searchQuery) => ipcRenderer.invoke('get-emails', searchQuery),
  getEmail: (id) => ipcRenderer.invoke('get-email', id),
  deleteEmail: (id) => ipcRenderer.invoke('delete-email', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  sendEmail: (emailData) => ipcRenderer.invoke('send-email', emailData),
  testConnection: (credentials) => ipcRenderer.invoke('test-connection', credentials),
  onEmailsUpdated: (callback) => {
    ipcRenderer.on('emails-updated', (event, count) => callback(count));
  },
  onSyncStatus: (callback) => {
    ipcRenderer.on('sync-status', (event, status) => callback(status));
  },
  clearEmails: () => ipcRenderer.invoke('clear-emails'),
  reprocessEmails: () => ipcRenderer.invoke('reprocess-emails'),
});


