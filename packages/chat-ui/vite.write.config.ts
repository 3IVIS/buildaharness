import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Aielia Write is served from myaielia.com/write, so its build needs base '/write/'. It is its own page (own entry,
// own output folder) that shares the chat-ui sources; the /try build in vite.config.ts is untouched.
// Dev only: the page posts every article save here so a person watching over ssh can read the article, outline and chat
// as they change (see mirrorStore in src/write/write-services.ts). Files: <dir>/<id>.json (latest) and <dir>/changes.jsonl.
const mirrorDir = process.env.WRITE_MIRROR_DIR || resolve(tmpdir(), 'write-mirror')
const mirror = {
  name: 'write-mirror',
  configureServer(server: import('vite').ViteDevServer) {
    mkdirSync(mirrorDir, { recursive: true })
    server.middlewares.use('/__mirror', (req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          const { id, bundle, kind } = JSON.parse(body)
          const safe = String(id).replace(/[^\w-]/g, '_')
          if (kind === 'save') writeFileSync(resolve(mirrorDir, `${safe}.json`), JSON.stringify(bundle, null, 2))
          appendFileSync(resolve(mirrorDir, 'changes.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, id, bundle }) + '\n')
        } catch { /* a bad post must never break the page */ }
        res.statusCode = 204
        res.end()
      })
    })
  },
}

const base = process.env.CHAT_UI_BASE || '/'

export default defineConfig({
  root: resolve(__dirname, 'write'),
  base,
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), mirror],
  resolve: { alias: { '/src': resolve(__dirname, 'src') } },
  build: { outDir: resolve(__dirname, 'dist-write'), emptyOutDir: true },
  server: { port: 3011, fs: { allow: [resolve(__dirname)] } },
})
