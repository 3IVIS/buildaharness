# Deployment

## Docker Compose (local / single-host)

```bash
cp .env.example .env        # fill every value
cd mastra-runner && npm install && cd ..    # one-time lockfile
docker compose up
```

All nine services start. Langfuse initialises its own database schema on first boot. The adapter runs `alembic upgrade head` before uvicorn starts.

### With real-time collaboration

```bash
docker compose -f docker-compose.yml -f docker-compose.collab.yml up
```

Adds a tenth service: the y-websocket server on port 1234. Set `VITE_COLLAB_SERVER_URL=ws://localhost:1234` in `.env.local`.

---

## Helm chart (Kubernetes / on-prem)

The Helm chart is at `deploy/helm/itsharness/`. It deploys all nine services with correct readiness probes, SIGTERM handling, and rolling updates.

```bash
helm install itsharness ./deploy/helm/itsharness \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.postgresPassword=$(openssl rand -base64 24) \
  --set secrets.litellmMasterKey=$(openssl rand -base64 32) \
  --set secrets.langfuseNextauthSecret=$(openssl rand -base64 32) \
  --set secrets.langfuseSalt=$(openssl rand -base64 32) \
  --set secrets.langfuseEncryptionKey=$(openssl rand -hex 32) \
  --set secrets.clickhousePassword=yourpassword \
  --set ingress.enabled=true \
  --set ingress.host=itsharness.your-domain.com
```

Post-install, `helm status itsharness` prints the SSO setup guide from `templates/NOTES.txt`.

### External Postgres / Redis (RDS, ElastiCache)

```yaml
# values.yaml
postgresql:
  enabled: false          # disable Bitnami sub-chart
  external:
    host: my-rds.us-east-1.rds.amazonaws.com
    port: 5432
    database: itsharness

redis:
  enabled: false          # disable Bitnami sub-chart
  external:
    host: my-elasticache.abc.cache.amazonaws.com
    port: 6379
```

### Existing secrets

```yaml
# values.yaml
secrets:
  existingSecret: my-itsharness-secrets   # K8s Secret with all required keys
```

### SSO / OIDC via Helm

```yaml
# values.yaml
oidc:
  enabled: true
  issuerUrl: https://keycloak.example.com/realms/itsharness
  clientId: itsharness
  redirectUri: https://itsharness.your-domain.com/auth/sso/callback
  adminGroups: itsharness-admins
```

Set `secrets.oidcClientSecret` to your OAuth2 client secret.

---

## SSO / OIDC (any deployment)

### Environment variables

| Variable | Description |
|---|---|
| `OIDC_ENABLED` | `true` to enable SSO login |
| `OIDC_ISSUER_URL` | OIDC issuer base URL — e.g. `https://keycloak.example.com/realms/itsharness` |
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

Create a realm named `itsharness`, add a client with:
- **Client ID:** `itsharness`
- **Access type:** `confidential`
- **Valid Redirect URIs:** `https://your-domain/auth/sso/callback`
- **Group mapper:** map the `groups` claim to the access token

Then set `OIDC_ISSUER_URL=https://keycloak.example.com/realms/itsharness` and the client credentials.

### SCIM provisioning

Point your IdP's SCIM provisioning at:

```
Base URL:  https://your-domain/scim/v2
Auth:      Bearer <SCIM_BEARER_TOKEN>
```

Supported operations: list users, get user, deactivate user (`PATCH` with `active: false`). User creation is handled automatically on first SSO login when `OIDC_AUTO_PROVISION=true`.

---

## Full environment variable reference

### Required secrets

| Variable | How to generate |
|---|---|
| `JWT_SECRET` | `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` |
| `LITELLM_MASTER_KEY` | `openssl rand -base64 32` |
| `LANGFUSE_NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `LANGFUSE_SALT` | `openssl rand -base64 32` |
| `LANGFUSE_ENCRYPTION_KEY` | `openssl rand -hex 32` (must be exactly 64 hex chars) |
| `CLICKHOUSE_PASSWORD` | any strong password |
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
| `REDIS_URL` | `redis://redis:6379/1` | Redis connection string |
| `ADAPTER_BASE_URL` | `http://localhost:8000` | Public adapter URL used in generated endpoint URLs |
| `A2A_BASE_URL` | `ADAPTER_BASE_URL` | Override for A2A endpoint URLs |
| `INVOKE_TIMEOUT_S` | `120` | Synchronous invoke timeout in seconds |
| `CORS_ORIGINS` | `http://localhost:3000,http://canvas:3000` | Comma-separated allowed origins |
| `JWT_TTL_DAYS` | `30` | Token lifetime in days |
| `MAX_BODY_BYTES` | `1048576` | Max request body size (1 MB) |
| `JOB_TTL_HOURS` | `4` | Hours before completed jobs are evicted |
| `TRUST_PROXY` | `true` | Reads `X-Real-IP`/`X-Forwarded-For`; set `false` if adapter is internet-facing without a proxy |
| `LANGFUSE_EVAL_ENABLED` | — | `true` to register LLM-as-judge evaluator configs at boot |

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
| `VITE_COLLAB_SERVER_URL` | _(unset)_ | y-websocket URL — e.g. `ws://localhost:1234`. Leave unset to disable collab. |
| `VITE_COLLAB_OFFLINE_PERSISTENCE` | `true` | Persist Yjs doc to IndexedDB |

---

## CI/CD pipeline

The `.github/workflows/deploy.yml` pipeline has five stages:

```
1. adapter-tests     pytest + ruff
2. build-and-push    docker build → ghcr.io (sha tag)
3. promote-staging   push staging tag → trigger staging deploy
4. deploy-staging    smoke_test.py — 5 checks against live adapter
5. deploy-production push latest + version tag
   └── post-deploy-eval   spec-validation + debate quality gate
```

`deploy_flows.py` (run post-deploy) iterates `flows/*.json` and deploys each flow to the live adapter. `smoke_test.py` checks `/health`, `/runtimes` (all 4), `/compile` × 4 runtimes, `/run` + poll, and AgentCard discovery.
