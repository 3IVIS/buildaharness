// Node.js entry point for Docker / self-hosted deployments.
// The CF Worker entry point (index.ts) exports a default Hono app which
// Wrangler runs directly. This file wraps the same app with @hono/node-server
// so it can be started with `node dist/server.js`.
import { serve } from '@hono/node-server'
import app from './index'

const port = parseInt(process.env.PORT ?? '3001', 10)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`buildaharness-proxy listening on http://localhost:${info.port}`)
})
