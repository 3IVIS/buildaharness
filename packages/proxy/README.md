# @buildaharness/proxy

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
docker build -t buildaharness-proxy .

# Run (all secrets passed as env vars — never bake them into the image)
docker run -p 3001:3001 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENAI_API_KEY=sk-... \
  -e PROXY_SECRET=your-secret \
  -e ALLOWED_ORIGIN=http://localhost:5173 \
  buildaharness-proxy
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
| `POST` | `/web/search` | Bearer JWT | Run a Brave web search server-side (`{ query, braveApiKey? }` → `{ results: [{ title, url, snippet, fetchTag }] }`). `braveApiKey` is normally the caller's own key — sent fresh on every request from chat-ui's Settings-stored config, never persisted here — and takes priority over the `BRAVE_API_KEY` Worker secret, which exists only as a fallback for a self-hosted operator who wants one shared key for their own deployment. This exists so the plain-browser build (blocked by CORS calling search providers directly) can search — see [`plans/browser_web_tools_via_proxy_plan.html`](../../plans/browser_web_tools_via_proxy_plan.html). Each result carries a `fetchTag` (see `/web/fetch` below) — a signed capability for that exact URL, not a general bearer of fetch rights. |
| `POST` | `/web/fetch` | Bearer JWT | Fetch a URL's text content server-side (`{ url, fetchTag }` → `{ text, finalUrl, truncated }`), so the plain-browser build gets a working `fetch_url` (blocked client-side by CORS + no browser DNS API). **Requires a `fetchTag`**: a signed-URL capability (`src/web-fetch-tag.ts`, `${exp}.${base64url(HMAC-SHA256(PROXY_SECRET, url + "\n" + exp))}`, ~15 min TTL) minted only by `/web/search` (for search results) or `/web/grant` (for user-pasted URLs) — a request whose `fetchTag` doesn't verify against the exact `url`, or has expired, gets `403 untagged target` before the fetch is even attempted. This closes the open-relay hole a bare authenticated fetch proxy would otherwise be: the model can only fetch a URL it was legitimately handed, not one it invented. Once past the tag check, runs the same SSRF guard as `fetch_url`'s desktop/CLI path (`src/web-fetch-core.ts`, a hand-kept-in-sync port of `packages/personal-assistant/src/web-fetch-core.ts` — see that file's header comment for why it isn't a workspace import): rejects non-http(s) schemes, credentialed URLs, non-80/443 ports, and raw IP literals outright; resolves the hostname and rejects a private/loopback/link-local/metadata address, re-checked on every redirect hop (`302 → private target` → `400`, not followed) — a redirect target itself needs no tag, since the client never sees it. Also enforces a streamed byte cap (`Content-Length` can lie) and a content-type allowlist checked against both the header and the sniffed body bytes (`415` if it looks binary); times out a hung fetch (`504`). Zero ambient authority: fixed `User-Agent`, no forwarded client cookies/`Authorization`/headers/IP. A guard rejection is always a `4xx`, never a silent fallback. **Known gap:** does not pin the outbound TCP connection to the resolved+validated address (a DNS-rebinding TOCTOU window exists between resolve and connect on this Node/self-hosted deploy target) — deferred, since verifying real socket-level pinning needs a live network the test sandbox that built this route doesn't have; see `plans/browser_web_tools_via_proxy_plan.html`'s W2 section for the residual-risk reasoning. |
| `POST` | `/web/grant` | Bearer JWT | Mints a `fetchTag` for a URL the caller vouches for outside of a search result — namely a URL the user typed verbatim in their own message (`{ url }` → `{ fetchTag }`). Callers must only grant URLs sourced directly from a user turn, never from tool output or model text — v1 trusts the caller on this (a later version could have the assistant sign a per-turn nonce instead). Rate-limited more tightly than `/web/fetch` itself (`WEB_GRANT_REQUESTS_PER_HOUR`, default 20/hour/sub) on top of the shared quota below — a URL-signing oracle deserves heavier throttling than an open fetch, since a tag can be replayed against `/web/fetch` repeatedly while valid. |

## Quotas & observability

Every `/web/*` route sits behind a shared, in-memory (single-instance — see the "runtime parity" note below) quota layer, tuned by the env vars documented in [`../../docs/env-vars.md`](../../docs/env-vars.md):

- **Per-token (JWT `sub`) requests/hour** — `WEB_REQUESTS_PER_HOUR` (default 120), shared across all three routes.
- **Per-client-IP requests/hour** — `WEB_PER_IP_REQUESTS_PER_HOUR` (default 30), layered in front of the per-`sub` ceiling. This matters specifically for a deployment like the hosted `/try` build, where every anonymous visitor shares one token — without it, the per-`sub` limit alone would be one global ceiling shared by everyone.
- **`/web/fetch`-specific:** a per-`sub` bytes/hour ceiling (`WEB_BYTES_PER_HOUR`, checked before each fetch and charged with the actual bytes consumed after — a single fetch's own byte cap is unaffected and still enforced by `web-fetch-core.ts`), a per-`sub` max-concurrent-fetches guard (`WEB_MAX_CONCURRENT_FETCHES`), and a proxy-wide per-destination-host throttle (`WEB_HOST_REQUESTS_PER_HOUR`) so the proxy can't be used to hammer one third party.
- **`/web/search`-specific:** a global (not per-`sub`/IP) daily ceiling on Brave calls (`WEB_BRAVE_DAILY_CEILING`), protecting the shared `BRAVE_API_KEY` fallback from being run up or banned by aggregate traffic. Doesn't apply to a request that brings its own `braveApiKey` — that's the caller's own Brave account and quota, not this deployment's.
- **`/web/grant`-specific:** its own tighter per-`sub` ceiling (`WEB_GRANT_REQUESTS_PER_HOUR`), see the endpoint table above.
- **Guard-rejection alerting:** repeated SSRF-guard/tag rejections from one `sub` within an hour (`WEB_GUARD_REJECT_ALERT_THRESHOLD`, default 5) log a `console.warn` alert line — a cheap signal that someone is probing the guard with private-range targets. Not itself a block.

Every `/web/*` call also emits one structured JSON log line via `console.log`/`console.warn` — `{ ts, sub, route, host?, status, bytes?, guardRejectReason? }` — deliberately never the query text or request/response body.

**Runtime parity.** Quota/concurrency state (`src/rate-limit.ts`) lives in module-level `Map`s — correct for a single Worker isolate or a single Node process, but not shared across multiple isolates/processes behind a load balancer. The route logic that calls into it doesn't know or care which store backs it, so swapping in a Cloudflare Rate Limiting binding / Durable Object / KV, or a Redis-backed store for multi-instance Node, is a change local to `rate-limit.ts` — flagged as a fast-follow in [`plans/browser_web_tools_via_proxy_plan.html`](../../plans/browser_web_tools_via_proxy_plan.html)'s W4 scope, not implemented here.

## Environment variables

See [`../../docs/env-vars.md`](../../docs/env-vars.md) for the full reference.
