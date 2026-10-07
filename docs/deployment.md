# Deployment

## Docker Compose (local / single-host)

```bash
./scripts/setup-env.sh      # first run: creates .env, generates secrets, writes .env.local
docker compose up
```

(Or `cp .env.example .env` and fill every `REPLACE_*` value by hand; `bash scripts/check-env.sh` verifies the result. If the mastra-runner image build fails on a missing `package-lock.json`, run `cd mastra-runner && npm install` once.)

Compose starts eleven long-running services (canvas, adapter, mastra-runner, postgres, redis, litellm, qdrant, clickhouse, minio, langfuse, langfuse-worker) plus a one-shot `minio-init` that creates the Langfuse bucket. Langfuse initialises its own database schema on first boot. The adapter runs `alembic upgrade head` before uvicorn starts.

### With real-time collaboration

```bash
docker compose -f docker-compose.yml -f docker-compose.collab.yml up
```

Adds one more service, `collab`: the y-websocket server on port 1234 (published on `127.0.0.1` only, with LevelDB persistence). It has no authentication of its own; see the header of `docker-compose.collab.yml` for the options. Set `VITE_COLLAB_SERVER_URL=ws://localhost:1234` in `.env.local`.

---

## Helm chart (Kubernetes / on-prem)

The Helm chart is at `deploy/helm/buildaharness/`. It deploys the adapter (2 replicas by default), canvas, mastra-runner, LiteLLM, Langfuse (web and worker), ClickHouse, and, through Bitnami sub-charts, Postgres and Redis. It does not deploy Qdrant or MinIO. The chart's Ingress can expose the adapter, canvas and Langfuse (`ingress.adapter.host`, `ingress.canvas.host`, `ingress.langfuse.host`).

```bash
helm install buildaharness ./deploy/helm/buildaharness \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.postgresPassword=$(openssl rand -base64 24) \
  --set secrets.redisPassword=$(openssl rand -base64 24) \
  --set secrets.litellmMasterKey=$(openssl rand -base64 32) \
  --set secrets.langfuse.nextauthSecret=$(openssl rand -base64 32) \
  --set secrets.langfuse.salt=$(openssl rand -base64 32) \
  --set secrets.langfuse.encryptionKey=$(openssl rand -hex 32) \
  --set secrets.langfuse.adminPassword=$(openssl rand -base64 16) \
  --set secrets.clickhousePassword=$(openssl rand -hex 24) \
  --set llm.openaiApiKey=sk-... \
  --set ingress.enabled=true \
  --set ingress.adapter.host=adapter.your-domain.com
```

Post-install, `helm status buildaharness` prints the SSO setup guide from `templates/NOTES.txt`.

### External Postgres / Redis (RDS, ElastiCache)

```yaml
# values.yaml
postgres:
  enabled: false          # disable Bitnami sub-chart
externalPostgres:
  host: my-rds.us-east-1.rds.amazonaws.com
  port: 5432
  username: buildaharness
  database: buildaharness

redis:
  enabled: false          # disable Bitnami sub-chart
externalRedis:
  host: my-elasticache.abc.cache.amazonaws.com
  port: 6379
  database: 1
```

### Existing secrets

```yaml
# values.yaml
secrets:
  existingSecret: my-buildaharness-secrets   # K8s Secret with all required keys
```

### SSO / OIDC via Helm

```yaml
# values.yaml
oidc:
  enabled: true
  issuerUrl: https://keycloak.example.com/realms/buildaharness
  clientId: buildaharness
  redirectUri: https://adapter.your-domain.com/auth/sso/callback   # the callback is served by the adapter
  adminGroups: buildaharness-admins
```

Set `secrets.oidcClientSecret` to your OAuth2 client secret.

---

## SSO / OIDC (any deployment)

### Environment variables

| Variable | Description |
|---|---|
| `OIDC_ENABLED` | `true` to enable SSO login |
| `OIDC_ISSUER_URL` | OIDC issuer base URL — e.g. `https://keycloak.example.com/realms/buildaharness` |
| `OIDC_CLIENT_ID` | OAuth2 client ID |
| `OIDC_CLIENT_SECRET` | OAuth2 client secret |
| `OIDC_REDIRECT_URI` | Full callback URL — must match what's registered with the provider |
| `OIDC_SCOPES` | Space-separated scopes (default: `openid email profile groups`) |
| `OIDC_GROUP_CLAIM` | JWT claim containing group names (default: `groups`) |
| `OIDC_ADMIN_GROUPS` | Comma-separated group names that map to org admin role |
| `OIDC_ORG_SLUG_CLAIM` | Claim used to resolve the target org (default: `org`) |
| `OIDC_AUTO_PROVISION` | `true` (default) creates users on first SSO login |
| `SCIM_BEARER_TOKEN` | Static bearer token for the SCIM 2.0 provisioning endpoint |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh token lifetime in days (default: `30`) |

### Keycloak quick-start

Create a realm named `buildaharness`, add a client with:
- **Client ID:** `buildaharness`
- **Access type:** `confidential`
- **Valid Redirect URIs:** `https://your-domain/auth/sso/callback`
- **Group mapper:** map the `groups` claim to the access token

Then set `OIDC_ISSUER_URL=https://keycloak.example.com/realms/buildaharness` and the client credentials.

### SCIM provisioning

Point your IdP's SCIM provisioning at:

```
Base URL:  https://your-domain/scim/v2
Auth:      Bearer <SCIM_BEARER_TOKEN>
```

Supported operations: list users, get user, deactivate user (`PATCH` with `active: false`). User creation is handled automatically on first SSO login when `OIDC_AUTO_PROVISION=true`.

---

## Full environment variable reference

The complete, code-verified reference is [env-vars.md](./env-vars.md); this section is a short summary.

### Required secrets

| Variable | How to generate |
|---|---|
| `JWT_SECRET` | `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` |
| `LITELLM_MASTER_KEY` | `openssl rand -base64 32` |
| `LANGFUSE_NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `LANGFUSE_SALT` | `openssl rand -base64 32` |
| `LANGFUSE_ENCRYPTION_KEY` | `openssl rand -hex 32` (must be exactly 64 hex chars) |
| `REDIS_PASSWORD` | `openssl rand -base64 24` |
| `CLICKHOUSE_PASSWORD` | `openssl rand -hex 24` (alphanumeric/hex only; special characters break the ClickHouse migration URL) |
| `LANGFUSE_ADMIN_EMAIL` | your email |
| `LANGFUSE_ADMIN_PASSWORD` | your password |

### LLM keys

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | For LLM nodes using OpenAI models |
| `ANTHROPIC_API_KEY` | For Anthropic models via LiteLLM |

### Adapter tuning

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | _(set by `docker-compose.yml`)_ | `redis://:<REDIS_PASSWORD>@redis:6379/1` — database 1 is the JWT blocklist |
| `ADAPTER_BASE_URL` | `http://localhost:8000` | Public adapter URL used in generated endpoint URLs |
| `A2A_BASE_URL` | `ADAPTER_BASE_URL` | Override for A2A endpoint URLs |
| `INVOKE_TIMEOUT_S` | `120` | Synchronous invoke timeout in seconds |
| `CORS_ORIGINS` | `http://localhost:3000,http://canvas:3000` | Comma-separated allowed origins |
| `JWT_TTL_DAYS` | `30` | Token lifetime in days |
| `MAX_BODY_BYTES` | `1048576` | Max request body size (1 MB) |
| `JOB_TTL_HOURS` | `4` | Hours before completed jobs are evicted |
| `TRUST_PROXY` | `true` | Reads `X-Real-IP`/`X-Forwarded-For` for rate limiting; set `false` if the adapter is internet-facing without a proxy |
| `LANGFUSE_EVAL_ENABLED` | `false` | `true` to register LLM-as-judge evaluator configs at boot |

### Langfuse (canvas)

Add to `.env.local` (never `.env` — Vite bakes these at build time):

| Variable | Description |
|---|---|
| `VITE_API_URL` | Adapter URL visible from the browser (default: `http://localhost:8000`) |
| `VITE_LANGFUSE_ENABLED` | `true` to enable canvas tracing |
| `VITE_LANGFUSE_PUBLIC_KEY` | Langfuse public key (same as `LANGFUSE_PUBLIC_KEY` in `.env`) |
| `VITE_LANGFUSE_HOST` | Langfuse host URL (default: `http://localhost:3001`) |

### Collaboration

| Variable | Default | Description |
|---|---|---|
| `VITE_COLLAB_SERVER_URL` | _(unset)_ | y-websocket URL — e.g. `ws://localhost:1234`. Leave unset to disable collab. The Yjs doc is always persisted to IndexedDB. |

---

## CI/CD pipeline

`.github/workflows/deploy.yml` runs on pushes to `main` (staging), `v*` tags (production), pull requests (build and test only, no push or deploy) and manual dispatch (including a "promote staging image to production" mode). Its jobs:

```
adapter-lint         ruff check + ruff format --check
adapter-typecheck    mypy
adapter-unit-tests   pytest tests/ + the MAF adapter tests
build-and-push       docker build -> ghcr.io (sha tag)          needs: the three above
promote-staging      re-tag the staging image as production     (manual promote only)
deploy-staging       deploy all reference flows, then smoke-test
deploy-production    deploy all reference flows, then smoke-test
```

`.github/scripts/deploy_flows.py` iterates `flows/*.json` and upserts each flow on the live adapter. `.github/scripts/smoke_test.py` checks `/health`, `/runtimes` (all 4), `/compile` for each of the 4 runtimes, `/run` plus polling until the job completes, and the default AgentCard at `/.well-known/agent.json`.
