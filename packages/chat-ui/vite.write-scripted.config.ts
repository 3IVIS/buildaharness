import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The scripted Write page for the Playwright specs (e2e/write-engagement.spec.ts): the real WriteApp over scripted model calls, no key needed.
export default defineConfig({
  root: resolve(__dirname, 'e2e/write-scripted'),
  plugins: [react()],
  resolve: { alias: { '/src': resolve(__dirname, 'src') } },
  server: { port: 4174, strictPort: true, host: '127.0.0.1', fs: { allow: [resolve(__dirname, '../..')] } },
})
