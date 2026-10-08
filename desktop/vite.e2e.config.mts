import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
const port = Number(process.env.MISAKA_E2E_PORT || 4174)

// Browser acceptance uses the real UI without launching Electron or a live model.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1', port, strictPort: true },
  build: { outDir: process.env.MISAKA_E2E_BUILD_DIR || 'dist-e2e', rollupOptions: { input: path.resolve('e2e/conversation.html') } },
})
