# itsharness

**A complete harness for building, running, and observing AI agent workflows.**

Design flows on a visual canvas → export a runtime-agnostic spec → compile to your framework → run, trace, debug, deploy, and share — all from one tool.

```
flow.json  →  [ langgraph adapter ]  →  Python / LangGraph
           →  [ crewai adapter ]     →  Python / CrewAI
           →  [ mastra adapter ]     →  TypeScript / Mastra
           →  [ REST endpoint ]      →  POST /flows/{id}/invoke
           →  [ MCP tool ]           →  Claude Desktop + any MCP client
           →  [ A2A agent ]          →  any A2A-compatible runtime
```

---

## What it is

Most agent tooling is either high-level (too much magic, hard to debug) or low-level (too much boilerplate, slow to iterate). itsharness sits in the middle:

- **Draw** — 14 node types on a visual canvas. Every spec field is directly editable.
- **Own the spec** — the canvas emits a versioned, runtime-agnostic JSON spec you control.
- **Compile** — one API call transforms the spec into runnable code for your framework.
- **Run and observe** — live node overlays, per-node token counts, Langfuse trace links, HITL pause/resume.
- **Deploy** — one click publishes the flow as a REST endpoint, MCP tool, and A2A agent simultaneously.
- **Share** — community components can be installed from the marketplace directly onto the canvas.

**The spec is the contract. The canvas is the editor. The adapters are the compilers.**

---

## Quick start

### 1. Configure secrets

```bash
cp .env.example .env
```

Open `.env` and set **every** value — the adapter will refuse to start if any are missing or still at placeholder values. Required secrets:

| Variable | How to generate |
|---|---|
| `JWT_SECRET` | `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` |
| `LITELLM_MASTER_KEY` | `openssl rand -base64 32` |
| `LANGFUSE_NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `LANGFUSE_SALT` | `openssl rand -base64 32` |
| `LANGFUSE_ENCRYPTION_KEY` | `openssl rand -hex 32` (must be exactly 64 hex chars) |
| `CLICKHOUSE_PASSWORD` | any strong password |
| `LANGFUSE_ADMIN_EMAIL` | your email address |
| `LANGFUSE_ADMIN_PASSWORD` | your chosen password |

Also add your LLM API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

> **Placeholder detection** — the adapter checks all secret values for known placeholder substrings (e.g. `REPLACE_ME`, `REPLACE_WITH_REAL_SECRET`) and exits with a clear error at startup. Replace every placeholder before starting the stack.

### 2. Generate the mastra-runner lockfile

The `mastra-runner` service is a separate Node.js package and needs its own
`package-lock.json` before Docker can build it. This is a one-time step:

```bash
cd mastra-runner && npm install && cd ..
```

> This only writes `mastra-runner/package-lock.json` to disk — it does not
> install anything into your global environment. Commit the lockfile so
> teammates don't need to repeat this step.

### 3. Start everything

```bash
docker compose up
```

| Service | URL |
|---|---|
| Canvas | http://localhost:3000 |
| Adapter API | http://localhost:8000/health |
| Langfuse UI | http://localhost:3001 |

Nine services start in total: canvas, mastra-runner, adapter, postgres, redis, clickhouse, litellm, langfuse, and langfuse-worker.

Log in to Langfuse with the `LANGFUSE_ADMIN_EMAIL` and `LANGFUSE_ADMIN_PASSWORD` you set in `.env`.

### Without Docker

```bash
# First-time setup — creates adapter/.venv, installs deps, writes .env + .env.local
./setup-env.sh

# Activate the venv
source adapter/.venv/bin/activate

# Canvas
npm install && npm run dev        # → http://localhost:3000

# Tests
npm test                          # Vitest — validates all 5 reference flows
pytest adapter/tests/ -v          # Adapter unit + integration suite

# Adapter (requires Postgres + env vars set)
cd adapter && python main.py
```

---

## Repository structure

```
itsharness/
│
├── spec/                        ← @itsharness/flow-spec — published npm package
│   ├── schema.ts                  Canonical Zod schema (source of truth)
│   ├── schema.json                Derived JSON Schema
│   └── CHANGELOG.md
│
├── flows/                       ← 5 reference example flows (JSON)
│
├── docs/adr/                    ← Architecture Decision Records
│   └── 001-codegen-field-semantics.md
│
├── src/                         ← Canvas app (React + TypeScript + XYFlow)
│   ├── spec/                      Canvas schema + cross-ref validation + examples
│   ├── store/index.ts             Zustand store — nodes, edges, execution state, deployment
│   ├── canvas/nodes/              14 node components with live execution overlay
│   ├── components/
│   │   ├── Sidebar.tsx            Node palette + Community marketplace tab
│   │   ├── Toolbar.tsx            Run, deploy, save, export actions
│   │   ├── ConfigPanel.tsx        Per-node config (all 14 types)
│   │   ├── DeploymentPanel.tsx    One-click deploy panel (REST + MCP + A2A)
│   │   ├── MarketplacePanel.tsx   Community component gallery
│   │   ├── HitlResumePanel.tsx    HITL pause/resume side panel
│   │   └── FlowSettingsModal.tsx  6-tab flow configuration
│   └── services/
│       ├── api.ts                 Typed API client (auth, flows, run, deploy, marketplace)
│       └── runPoller.ts           Polls job status → live overlay + trace linking
│
├── adapter/                     ← FastAPI backend (v0.7.0)
│   ├── main.py                    App entry point + router registration
│   ├── db.py                      SQLAlchemy async models + ORM
│   ├── run_api.py                 /run — async execution + Langfuse tracing
│   ├── flows_api.py               /flows — CRUD + versioning
│   ├── auth.py                    /auth — JWT + Redis revocation
│   ├── a2a_api.py                 A2A protocol — discovery, tasks, deploy
│   ├── deploy_api.py              One-click deploy — REST + MCP + A2A unified
│   ├── marketplace_api.py         Community component registry
│   ├── eval_api.py                Langfuse LLM-as-judge eval endpoints
│   ├── prompts_api.py             Langfuse Prompt Management proxy
│   ├── teams_api.py               Team RBAC — members + flow sharing
│   ├── orgs_api.py                Multi-tenant org management
│   ├── langgraph_adapter.py       LangGraph codegen — all 14 nodes
│   ├── crewai_adapter.py          CrewAI codegen — all 14 nodes
│   ├── mastra_adapter.py          Mastra TypeScript codegen
│   ├── migrations/versions/       Alembic migrations 0001–0007
│   └── tests/                     Pytest suite (auth, flows, A2A, deploy, marketplace, ...)
│
├── mastra-runner/               ← Node.js sidecar for Mastra execution
│
├── infra/postgres-init.sql      ← Creates langfuse + litellm databases on first boot
├── docker-compose.yml           ← 9 services
├── .env.example                 ← All env vars with generation hints
└── CONTRIBUTING.md
```

> **`spec/schema.ts` vs `src/spec/schema.ts`** — `spec/schema.ts` is the canonical schema published as `@itsharness/flow-spec`. The canvas copy omits `.refine()` calls (required by Zod's discriminated union). When the spec changes, update both files and run `npm test`.

---

## The spec — `@itsharness/flow-spec`

**Current version:** `0.2.0` · **RFC:** closed — codegen field semantics formalised in [`docs/adr/001`](./docs/adr/001-codegen-field-semantics.md)

### The 14 node types

| Node | What it does | Runtime support |
|---|---|---|
| `input` | Flow entry point; declares output schema | All |
| `output` | Flow exit point; optional exit code | All |
| `llm_call` | Single LLM invocation — structured output, validator, fail_branch, Langfuse-managed prompts | All |
| `tool_invoke` | Calls a named tool from the flow's `tools` registry | All |
| `condition` | Branching — JSONPath expression or `fn_ref` | All |
| `parallel_fork` | Fan-out to N concurrent branches | All |
| `parallel_join` | Fan-in — configurable reducer: `merge`, `append`, `fn_ref` | All |
| `hitl_breakpoint` | Suspend execution; wait for a typed human resume payload | All (adapter variation) |
| `memory_read` | Read from a named store — key-value or semantic (vector) | All |
| `memory_write` | Write to a named store — upsert or overwrite | All |
| `subgraph` | Embed another flow as a node | LG/MA: full · CR: partial |
| `transform` | State transformation — `mapping` (no-code) or `fn_ref` | All |
| `agent_role` | Execute an agent persona from the `agents[]` registry | CR: native · LG/MA: synthesised |
| `agent_debate` | Multi-agent conversation loop with termination condition | CR: native · Others: synthesised |

### Key field semantics (ADR-001)

| Field | Semantics |
|---|---|
| `output_key` | Direct state-dict write: node returns `{output_key: result}`. If absent on `llm_call`, result is discarded (canvas warns). |
| `query_expr` / `key_expr` / `value_expr` | Bare JSONPath selectors (`$.state.field`), resolved by `_resolve(state, expr)` in all adapters. |
| `context_from` | CrewAI → `Task.context=[...]`. LangGraph → comment annotation. Mastra → step input mapping. |
| `memory_write.tier` | CrewAI → `XXXMemory()` instances in `Crew()` constructor. Other adapters → comment-only hint. |

### `fn_ref` format and security

`fn_ref` values are validated against a strict allowlist at **every entry point** (`/compile`, `/flows`, `/run`) before reaching any codegen or `exec()` call:

- **Python format:** `module.path:function_name`
- **npm format:** `@scope/package/export`
- **Local format:** `./path/to/file:fn`
- **Rejected:** path traversal (`../`), shell special characters (`;`, `|`, `&`, `` ` ``, `$`), multiple colons, parentheses

### A minimal flow

```json
{
  "spec_version": "0.2.0",
  "id": "hello-flow",
  "runtime_hints": { "preferred_adapter": "langgraph" },
  "state_schema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" },
      "answer":   { "type": "string" }
    }
  },
  "nodes": [
    { "id": "start",  "type": "input" },
    { "id": "answer", "type": "llm_call", "prompt_template": "Answer this: {{$.state.question}}", "output_key": "answer" },
    { "id": "done",   "type": "output" }
  ],
  "edges": [
    { "type": "direct", "from": "start",  "to": "answer" },
    { "type": "direct", "from": "answer", "to": "done"   }
  ]
}
```

### Example flows

| Flow | Runtime | Exercises |
|---|---|---|
| [01 — RAG Agent](./flows/01-rag-agent-flow.json) | LangGraph | `memory_read` semantic, `transform` fn_ref, vector + kv stores |
| [02 — Content Moderation + HITL](./flows/02-content-moderation-hitl-flow.json) | Mastra | `llm_call` structured output, `condition`, `hitl_breakpoint` |
| [03 — Parallel Risk Assessment](./flows/03-parallel-risk-assessment-flow.json) | CrewAI | `parallel_fork/join`, `agent_role` ×3, `memory_access: "isolated"` |
| [04 — Research Crew](./flows/04-research-crew-flow.json) | CrewAI | `context_from` on edges, `tool_approval: "human"` |
| [05 — Debate Agent + A2A](./flows/05-debate-agent-a2a-flow.json) | MS Agent Framework *(Phase 4)* | `agent_debate`, `a2a_config` |

---

## The canvas

**Authoring**
- All 14 node types with per-type config panels — every spec field editable
- Drag-to-add from node palette, drag-to-connect between handles
- Auto-layout (dagre LR), undo/redo (50 steps), keyboard shortcuts
- Runtime compatibility badges per node (LG / CR / MA)
- Cmd+K command palette, annotation sticky notes, edge midpoint insert, flow version diff

**Sidebar tabs**
- **Nodes** — built-in palette grouped by family (I/O, Core, Control, Memory, Agents)
- **Community** — searchable marketplace gallery; one-click install drops the node and registers its tool in the flow's tools registry

**Validation**
- Zod + cross-ref validation on every export — inline error badges, Problems panel
- ADR-001 authoring warnings for common spec mistakes

**Execution overlay**
- Per-node status: pending → running (blue pulse) → paused (amber pulse) → done (green) → error (red)
- Per-node timing (ms) and token count badge
- "View trace →" link after run, opening the Langfuse trace in a new tab
- Thumbs-up/down feedback bar in the run-complete toast

**HITL pause/resume**
- Paused node gets amber ring; HitlResumePanel shows prompt and editable resume fields
- Resume button → `POST /run/{job_id}/resume` → graph continues from checkpoint
- Multiple sequential HITL nodes work

---

## The adapters

### Authentication

All adapter endpoints require a JWT:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "YourPassword1"}' | jq -r .token)
```

Passwords must be at least 8 characters and contain at least one letter and one digit.

### Compile a flow

```bash
# LangGraph
curl -s -X POST "http://localhost:8000/compile?runtime=langgraph" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/01-rag-agent-flow.json)}" | jq -r .code

# CrewAI
curl -s -X POST "http://localhost:8000/compile?runtime=crewai" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/03-parallel-risk-assessment-flow.json)}" | jq -r .code
```

The `runtime` param is optional — omitting it uses `runtime_hints.preferred_adapter` from the spec, defaulting to `langgraph`.

### Adapter coverage

| Runtime | Status | Notes |
|---|---|---|
| **LangGraph** · Python · MIT | ✅ Full | All 14 nodes · `@observe` trace + child spans · HITL via `interrupt()` |
| **CrewAI** · Python · MIT | ✅ Full | All 14 nodes · `context_from→Task.context` · tier-aware `Crew()` memory |
| **Mastra** · TypeScript · Apache 2 | ✅ Full | All 14 nodes · Node.js sidecar execution · `suspend()/resume()` HITL |
| **MS Agent Framework** | ⬜ Planned | Phase 4 — MAF v1.0 GA'd Apr 2026 |

### Execute a flow

```bash
# Start a job
JOB=$(curl -s -X POST "http://localhost:8000/run?runtime=langgraph" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/01-rag-agent-flow.json)}" | jq -r .job_id)

# Poll status
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/run/$JOB" | jq '{status, trace_url}'

# Resume a paused HITL flow
curl -s -X POST "http://localhost:8000/run/$JOB/resume" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"decision": "approved", "notes": "LGTM"}}'
```

### Synchronous invocation (deployed flows)

Flows that have been deployed via `POST /deploy/{flow_id}` can be invoked synchronously:

```bash
curl -s -X POST "http://localhost:8000/flows/my-flow/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "What is the capital of France?"}}'
```

Returns the result directly when the flow completes (default timeout: 120 s). Use `POST /run` + polling for long-running flows or flows with HITL nodes.

---

## Deployment

### One-click deploy

The Deploy button in the Toolbar (or `POST /deploy/{flow_id}`) publishes a flow as three targets simultaneously:

| Target | URL | Description |
|---|---|---|
| REST endpoint | `POST /flows/{id}/invoke` | Synchronous execution via HTTP |
| MCP tool | `GET /.well-known/mcp/{id}.json` | Tool manifest for Claude Desktop and MCP clients |
| A2A agent | `POST /a2a/{id}/tasks/send` | Agent-to-Agent protocol (when `a2a_config.enabled`) |

A shareable URL (`GET /share/{id}`) returns public metadata for all three endpoints.

The `DeploymentPanel` sidebar shows each endpoint with a collapsible curl snippet and a `claude_desktop_config.json` snippet ready to paste for MCP integration.

### A2A protocol

When `flow_config.a2a_config.enabled = true`, deploying the flow also publishes an A2A AgentCard:

```
GET /.well-known/agent/{flow_id}.json   AgentCard (public — no auth)
POST /a2a/{flow_id}/tasks/send          Submit a task
GET  /a2a/{flow_id}/tasks/{task_id}     Task status
GET  /a2a/{flow_id}/tasks/{task_id}/events  SSE stream of task events
```

Configure in Flow Settings → Config → A2A exposure, then click Deploy.

---

## Community marketplace

The **Community** tab in the Sidebar shows the component marketplace. Components are pre-configured `tool_invoke` nodes published as npm packages. Clicking **Install** on a component:

1. Adds the node to the canvas at the default position
2. Registers the component's `tool_def` in the flow's tools registry under `tool_id`

Six verified `@itsharness` components are available out of the box:

| Component | npm package |
|---|---|
| 🔍 Web Search | `@langchain/community/tools/TavilySearchResults` |
| 📄 PDF Reader | `@itsharness/tool-pdf-reader` |
| 💬 Slack Notifier | `@langchain/community/tools/SlackTool` |
| 🐙 GitHub Issues | `@langchain/community/tools/GitHubToolkit` |
| 🗄️ SQL Query | `@langchain/community/tools/SqlTool` |
| 🌐 HTTP Request | `@itsharness/tool-http-request` |

Publish your own component at `POST /marketplace` (JWT required).

---

## Teams and organisations

itsharness supports multi-tenant deployments with org-level isolation and team-based access control.

**Organisations** — every user belongs to a personal org by default. Orgs can have per-org Langfuse keys so traces are isolated per tenant.

**Teams** — three roles: `admin`, `editor`, `viewer`. Teams can be granted `view` or `edit` access to flows. Managed via the `/teams` endpoints.

**Multi-tenancy** — LangGraph job thread IDs are namespaced as `{org_id}:{job_id}`, preventing state bleed between orgs.

---

## Observability

### Stack

```
ClickHouse 24.3    → trace + analytics storage
Redis 7            → Langfuse ingestion queue + JWT revocation blocklist
Langfuse 3 web     → UI + API  (http://localhost:3001)
Langfuse 3 worker  → async trace persistence to ClickHouse
```

All started automatically with `docker compose up`.

### What's traced

| Source | Langfuse content |
|---|---|
| **Job runners** | One trace per run (`crewai-flow-run` / `langgraph-flow-run`) via `@observe` |
| **Node execution** | Child OTel span per node — name, timing, output keys |
| **LiteLLM** | Every LLM call — model, tokens, cost, latency — automatic callback |
| **Canvas** | Session events linked to the active execution trace |
| **LLM-as-judge** | `POST /eval/score` writes programmatic scores to traces; `POST /eval/feedback` records user thumbs signals |
| **Prompt management** | `llm_call` nodes with `prompt_ref` resolve Langfuse-managed prompts at runtime |

### Enable canvas tracing

Add to `.env.local`:

```bash
VITE_LANGFUSE_ENABLED=true
VITE_LANGFUSE_PUBLIC_KEY=<same as LANGFUSE_PUBLIC_KEY in .env>
VITE_LANGFUSE_HOST=http://localhost:3001
```

---

## API reference

All endpoints except `/health`, `/runtimes`, the A2A discovery routes, and the marketplace list/detail routes require `Authorization: Bearer <token>`.

```
# Auth
POST /auth/register               Create account → JWT  (201)
POST /auth/login                  Login → JWT
POST /auth/logout                 Revoke current JWT (jti blocklisted in Redis)
GET  /auth/me                     Current user

# Flows
GET  /flows                       List user's flows (paginated)
POST /flows                       Save / upsert flow (auto-versions)
GET  /flows/{id}                  Current spec
DELETE /flows/{id}                Delete flow + all versions
GET  /flows/{id}/versions         Version history
POST /flows/{id}/versions/{v}/restore  Restore a version
POST /flows/{id}/invoke           Synchronous execution (deployed flows only)

# Execution
POST /run                         Execute flow async → {job_id}
GET  /run/{job_id}                Job status, node_events, trace_id, trace_url
POST /run/{job_id}/resume         Resume a paused HITL flow

# Deploy
POST   /deploy/{flow_id}          One-click deploy (REST + MCP + A2A)
DELETE /deploy/{flow_id}          Undeploy all
GET    /share/{flow_id}           Public deployment metadata (no auth)
GET    /.well-known/mcp/{id}.json MCP tool manifest (no auth)

# A2A
POST   /deploy/a2a/{flow_id}      Deploy as A2A agent only
DELETE /deploy/a2a/{flow_id}      Undeploy A2A only
GET    /.well-known/agent/{id}.json   AgentCard (no auth)
POST   /a2a/{flow_id}/tasks/send      Submit A2A task
GET    /a2a/{flow_id}/tasks/{id}      Task status
GET    /a2a/{flow_id}/tasks/{id}/events  SSE stream

# Marketplace
GET  /marketplace                 List community components (no auth)
GET  /marketplace/{slug}          Component detail (no auth)
POST /marketplace                 Publish a component
POST /marketplace/{slug}/install  Install → returns node_spec + tool_def

# Teams / Orgs
POST /teams                       Create team
GET  /teams                       List caller's teams
GET  /teams/{id}                  Team detail + members
PATCH  /teams/{id}                Rename (admin)
DELETE /teams/{id}                Delete (admin)
POST   /teams/{id}/members        Invite member
PATCH  /teams/{id}/members/{uid}  Change role
DELETE /teams/{id}/members/{uid}  Remove member
POST   /teams/{id}/flows/{fid}    Share flow with team
DELETE /teams/{id}/flows/{fid}    Unshare flow
GET    /teams/{id}/flows          List shared flows

# Eval
POST /eval/score                  Write LLM-as-judge score to a trace
POST /eval/feedback               User thumbs signal (+1 / -1 / 0)
GET  /eval/templates              Active evaluator configs
GET  /eval/scores                 Scores for a trace

# Prompts
GET /prompts                      List Langfuse-managed prompts
GET /prompts/{name}               Versions + preview for a prompt

# Codegen
POST /compile                     Spec → code (30 req/min)
GET  /health                      Adapter status (no auth)
GET  /runtimes                    Available runtimes (no auth)
```

---

## Security model

**Authentication** — JWTs signed with HS256. Every protected endpoint requires a valid, non-expired token with a `jti` claim. `POST /auth/logout` immediately revokes a token by writing its jti to Redis. Login always runs bcrypt regardless of whether the email exists, preventing timing-based user enumeration.

**`fn_ref` validation** — `fn_ref` values are validated at all three entry points (`/compile`, `/flows`, `/run`) against a strict allowlist regex before reaching any codegen or `exec()` call. Path traversal, shell special characters, and multiple colons are all rejected with a 400 error.

**Request limits** — body size capped at `MAX_BODY_BYTES` (default 1 MB). Rate limits on all mutating endpoints via slowapi.

**Secret validation** — the adapter inspects all required secrets at startup and exits immediately if any are missing or contain placeholder substrings.

**Response headers** — every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.

**Container hardening** — both Dockerfiles run as non-root users.

---

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT signing key — `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | ✅ | Postgres password |
| `LITELLM_MASTER_KEY` | ✅ | LiteLLM proxy master key |
| `LANGFUSE_ADMIN_EMAIL` | ✅ | Langfuse admin email |
| `LANGFUSE_ADMIN_PASSWORD` | ✅ | Langfuse admin password |
| `LANGFUSE_NEXTAUTH_SECRET` | ✅ | `openssl rand -base64 32` |
| `LANGFUSE_SALT` | ✅ | `openssl rand -base64 32` |
| `LANGFUSE_ENCRYPTION_KEY` | ✅ | `openssl rand -hex 32` (64 hex chars) |
| `CLICKHOUSE_PASSWORD` | ✅ | ClickHouse password |
| `OPENAI_API_KEY` | recommended | For LLM nodes using OpenAI models |
| `ANTHROPIC_API_KEY` | optional | For Anthropic models via LiteLLM |
| `LANGFUSE_PUBLIC_KEY` | optional | Enables Langfuse tracing |
| `LANGFUSE_SECRET_KEY` | optional | Required when `LANGFUSE_PUBLIC_KEY` is set |
| `REDIS_URL` | optional | Redis connection string (default: `redis://redis:6379/1`) |
| `ADAPTER_BASE_URL` | optional | Public adapter URL used in generated endpoint URLs (default: `http://localhost:8000`) |
| `A2A_BASE_URL` | optional | Override for A2A endpoint URLs; defaults to `ADAPTER_BASE_URL` |
| `INVOKE_TIMEOUT_S` | optional | Synchronous invoke timeout in seconds (default: `120`) |
| `CORS_ORIGINS` | optional | Comma-separated allowed origins (default: `http://localhost:3000,http://canvas:3000`) |
| `JWT_TTL_DAYS` | optional | Token lifetime in days (default: `30`) |
| `MAX_BODY_BYTES` | optional | Max request body size (default: `1048576` — 1 MB) |
| `JOB_TTL_HOURS` | optional | Hours before completed jobs are evicted (default: `4`) |
| `TRUST_PROXY` | optional | `true` (default) reads `X-Real-IP`/`X-Forwarded-For`; set `false` if adapter is internet-facing |
| `LANGFUSE_EVAL_ENABLED` | optional | Set `true` to register LLM-as-judge evaluator configs at boot |

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0 — Spec design** | FlowSpec schema v0.2 · 14 node types · 5 reference flows · npm publish · RFC closed (ADR-001) | ✅ Complete |
| **1 — Canvas + adapters** | XYFlow canvas · Zod validation · LangGraph + CrewAI + Mastra adapters · auth · versioning · live overlay | ✅ Complete |
| **2 — Observability + HITL** | HITL pause/resume · Langfuse self-host · OTel traces · token counts · LiteLLM cost tracking | ✅ Complete |
| **3 — Teams + eval + deploy + marketplace** | Team RBAC · JWT revocation · offline/online eval · prompt versioning · A2A scaffolding · Postgres job store · Alembic migrations · one-click deploy · community marketplace | ✅ Complete — v0.7.0 |
| **4 — Enterprise + collab + MS** | Real-time collab (Yjs) · MS Agent Framework adapter · SSO (Keycloak) · Visual CI/CD · on-prem Helm chart · `@itsharness/canvas` npm package | ⬜ Planned |

---

## Key design decisions

**Neutral spec IR as the anchor.** The canvas emits a neutral JSON spec. Adapters translate it. Swapping runtimes means updating one adapter file. Canvas, versioning, RBAC, eval, and collaboration are fully decoupled from runtime choice.

**TypeScript on XYFlow, not Python on LangFlow.** LangFlow's canvas wires components; a harness needs to author state machines. XYFlow delivers the correct canvas model with a single-language stack and a future embeddable package path.

**Langfuse (MIT, self-hosted) over LangSmith.** LangSmith is proprietary SaaS. Langfuse is MIT, self-hostable, OTel-compatible. The Python SDK v4 uses OTel as its native transport, making per-node child spans straightforward via `contextvars.copy_context().run()`.

**ADR-001 as the spec-to-adapter contract.** Four field semantics were left open during spec design. Closing them via ADR rather than schema change means zero breaking changes and a permanent reference for future adapter authors.

**`fn_ref` allowlist over sandboxing.** Generated code is exec'd directly. Full sandboxing is complex and escape-prone. Validating `fn_ref` values against a strict allowlist at every entry point before any codegen or exec() call is simpler, auditable, and effective.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
