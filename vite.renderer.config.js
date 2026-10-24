import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Tauri CLI sets TAURI_ENV_* when it runs this config; its devUrl expects port 1420
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [react()],
  ...(isTauri && {
    clearScreen: false,
    server: { port: 1420, strictPort: true },
  }),
  root: path.resolve(__dirname, './src/renderer'),
  build: {
    // With a custom root, Forge's relative output folder would end up inside src/renderer
    // and the packaged app would not contain the UI
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
});

