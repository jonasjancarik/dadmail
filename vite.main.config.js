import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    format: 'es',
    rollupOptions: {
      external: ['electron', 'better-sqlite3', 'imap-simple', 'mailparser', 'nodemailer', 'dompurify', 'jsdom'],
    },
  },
  resolve: {
    // Electron main process can use Node.js APIs
  },
});

