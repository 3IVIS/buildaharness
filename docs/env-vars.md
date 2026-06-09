# Environment Variables

## Proxy (server-side)

These variables are read by the `@itsharness/proxy` Hono app — either the Cloudflare Worker or the Node.js Docker image. They **never** leave the server.

| Variable | Required | Secret | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes* | **Secret** | Anthropic API key (`sk-ant-…`). Required when using Claude models. |
| `OPENAI_API_KEY` | Yes* | **Secret** | OpenAI API key (`sk-…`). Required when using GPT models. |
| `PROXY_SECRET` | Yes | **Secret** | Shared secret used to issue and verify short-lived JWTs. Set to a long random string. |
| `ALLOWED_ORIGIN` | Yes | Public | The URL of your frontend app (e.g. `https://app.example.com`). Only requests from this origin are accepted. Wildcard (`*`) is not permitted. |
| `PORT` | No | Public | Port the Node.js server listens on. Defaults to `3001`. Ignored by the CF Worker (use `[dev].port` in `wrangler.toml` instead). |

\* At least one of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` must be set depending on which models your flows use.

**CF Worker:** Set secrets with `wrangler secret put <NAME>` — never in `wrangler.toml`. Set `ALLOWED_ORIGIN` and `PORT` in the `[vars]` section of `wrangler.toml`.

**Docker/Node.js:** Pass all variables as container environment variables or copy `.env.example` → `.env` and use `docker compose up`.

---

## React app (client-side)

These variables are set in `templates/react-app/.env.local` and are **bundled into the browser build** by Vite. They are visible to anyone who loads the app.

| Variable | Required | Secret | Description |
|---|---|---|---|
| `VITE_PROXY_URL` | Yes | Public | Base URL of the proxy (e.g. `https://proxy.example.com`). Bundled into the browser build. |
| `VITE_AUTH_TOKEN` | No | **Development-only** | Pre-issued JWT for the proxy. **Only appropriate for development and private/internal deployments.** In a publicly accessible production app, obtain tokens at runtime via `POST /auth/token` instead of baking them into the build. |

> **Warning:** `VITE_AUTH_TOKEN` is embedded in the JavaScript bundle that ships to the browser. Any visitor to your site can read it. Do not use it for public production deployments.
