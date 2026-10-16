import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Aielia Write is served from myaielia.com/write, so its build needs base '/write/'. It is its own page (own entry,
// own output folder) that shares the chat-ui sources; the /try build in vite.config.ts is untouched.
const base = process.env.CHAT_UI_BASE || '/'

export default defineConfig({
  root: resolve(__dirname, 'write'),
  base,
  publicDir: resolve(__dirname, 'public'),
  plugins: [react()],
  resolve: { alias: { '/src': resolve(__dirname, 'src') } },
  build: { outDir: resolve(__dirname, 'dist-write'), emptyOutDir: true },
  server: { port: 3011, fs: { allow: [resolve(__dirname)] } },
})
