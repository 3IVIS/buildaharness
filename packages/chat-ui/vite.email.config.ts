import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Aielia Email is served from its own subdomain (decision 2), so its build uses base '/'. It is its own page (own entry,
// own output folder) that shares the chat-ui sources. Unlike Write there is no dev mirror here: mail content must not be written to disk by the dev server.
const base = process.env.CHAT_UI_BASE || '/'

export default defineConfig({
  root: resolve(__dirname, 'email'),
  base,
  publicDir: resolve(__dirname, 'public'),
  plugins: [react()],
  resolve: { alias: { '/src': resolve(__dirname, 'src') } },
  build: { outDir: resolve(__dirname, 'dist-email'), emptyOutDir: true },
  server: { port: 3012, fs: { allow: [resolve(__dirname)] } },
})
