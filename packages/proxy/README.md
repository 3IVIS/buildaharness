# @itsharness/proxy

LLM proxy that keeps API keys server-side. Ships as both a **Cloudflare Worker** (zero-infrastructure deploy) and a **Node.js/Docker service** (self-hosted).

## Quickstart — Cloudflare Worker

```bash
# 1. Authenticate with Cloudflare
wrangler login

# 2. Set secrets (stored encrypted in Cloudflare — never in wrangler.toml)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put PROXY_SECRET

# 3. Set the allowed origin for CORS (your frontend URL)
#    Edit wrangler.toml [vars] ALLOWED_ORIGIN, or override per environment.

# 4. Deploy
wrangler deploy
```

### Local dev (miniflare)

Create `.dev.vars` (gitignored) in this directory:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
PROXY_SECRET=local-secret
ALLOWED_ORIGIN=http://localhost:5173
```

Then run:

```bash
wrangler dev
```

The proxy starts on `http://localhost:3001`.

### Route configuration

After deploying, add a route in `wrangler.toml` to serve traffic from your domain:

```toml
[[routes]]
pattern = "proxy.yourdomain.com/*"
zone_name = "yourdomain.com"
```

## Quickstart — Node.js / Docker

```bash
# Build
docker build -t itsharness-proxy .

# Run (all secrets passed as env vars — never bake them into the image)
docker run -p 3001:3001 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENAI_API_KEY=sk-... \
  -e PROXY_SECRET=your-secret \
  -e ALLOWED_ORIGIN=http://localhost:5173 \
  itsharness-proxy
```

### docker-compose (proxy + static React app)

See `docker-compose.yml` in this directory. Copy `.env.example` to `.env` and fill in your secrets, then:

```bash
docker compose up
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Health check (returns `{"status":"ok"}`) |
| `POST` | `/auth/token` | — | Exchange `PROXY_SECRET` for a short-lived JWT |
| `POST` | `/llm/chat` | Bearer JWT | Forward chat completion request to Anthropic or OpenAI |

## Environment variables

See [`../../docs/env-vars.md`](../../docs/env-vars.md) for the full reference.
