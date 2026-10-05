import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import path from 'node:path'

// NOTE: this package intentionally has no "type": "module". vite-plugin-electron reads
// that field to decide its output format, and a sandboxed Electron preload must be
// CommonJS -- an ESM preload silently fails to load and leaves window.bridge undefined.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron([
      {
        entry: 'electron/main.ts',
      },
      {
        entry: 'electron/preload.ts',
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
