# itsharness

**A complete harness for building, running, and observing AI agent workflows.**

Design flows on a visual canvas → export a runtime-agnostic spec → compile to your framework → run, trace, and debug — all from one tool.

```
flow.json  →  [ langgraph adapter ]  →  Python / LangGraph
           →  [ crewai adapter ]     →  Python / CrewAI
           →  [ mastra adapter ]     →  TypeScript / Mastra
           →  [ A2A protocol ]       →  any A2A-compatible runtime
```

---

## What it is

Most agent tooling is either high-level (too much magic, hard to debug) or low-level (too much boilerplate, slow to iterate). itsharness sits in the middle:

- **Draw** — 14 node types on a visual canvas. Every spec field is directly editable.
- **Own the spec** — the canvas emits a versioned, runtime-agnostic JSON spec you control.
- **Compile** — one API call transforms the spec into runnable code for your framework.
- **Run and observe** — live node overlays, per-node token counts, Langfuse trace links, HITL pause/resume.

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

> **Placeholder detection** — the adapter checks all secret values for known placeholder substrings (e.g. `REPLACE_ME`, `REPLACE_WITH_REAL_SECRET`) and exits with a clear error message if any are found. This includes prefixed values like `pk-lf-REPLACE_ME`. Replace every placeholder before starting the stack.

### 2. Start everything

```bash
docker compose up
```

| Service | URL |
|---|---|
| Canvas | http://localhost:3000 |
| Adapter API | http://localhost:8000/health |
| Langfuse UI | http://localhost:3001 |

Log in to Langfuse with the `LANGFUSE_ADMIN_EMAIL` and `LANGFUSE_ADMIN_PASSWORD` you set in `.env`.

### Without Docker

Always use a virtual environment to keep itsharness's dependencies isolated from anything else on your machine (the `setup-env.sh` script creates one automatically at `adapter/.venv`):

```bash
# First-time setup — creates adapter/.venv, installs deps, writes .env + .env.local
./setup-env.sh

# Activate the venv in your current shell session
source adapter/.venv/bin/activate

# Canvas
npm install && npm run dev        # → http://localhost:3000

# Tests
npm test                          # Vitest — validates all 5 reference flows
pytest adapter/tests/ -v          # Adapter — auth, flows, compile, spec validation

# Adapter (requires Postgres + env vars set in shell or .env)
cd adapter && python main.py
```

> If you install Python packages without the venv, pip may report conflicts with other tools on your machine (e.g. Snowflake, AWS CLI). Those warnings are harmless to itsharness but pollute your global environment. The venv prevents this entirely.

---

## Repository structure

```
itsharness/
│
├── spec/                        ← @itsharness/flow-spec — published npm package
│   ├── schema.ts                  Canonical Zod schema (source of truth)
│   ├── schema.json                Derived JSON Schema (use for non-TS validation)
│   ├── CHANGELOG.md               Version history
│   └── package.json
│
├── flows/                       ← 5 reference example flows (JSON)
│
├── docs/
│   └── adr/
│       └── 001-codegen-field-semantics.md  ADR-001: output_key, *_expr, context_from
│
├── src/                         ← Canvas app (React + TypeScript + XYFlow)
│   ├── spec/
│   │   ├── schema.ts              Canvas copy of spec/schema.ts (no .refine())
│   │   ├── validation.ts          Cross-ref rules + ADR-001 authoring warnings
│   │   ├── examples.ts            5 example flows as TS constants
│   │   └── schema.test.ts         Vitest suite
│   ├── store/
│   │   └── index.ts               Zustand store (nodes, edges, execStats, hitlState, traceUrl)
│   ├── canvas/
│   │   └── nodes/                 14 node components — exec overlay, HITL amber ring
│   ├── components/
│   │   ├── ConfigPanel.tsx        Per-node config (all 14 types)
│   │   ├── HitlResumePanel.tsx    HITL pause/resume side panel
│   │   └── ...
│   └── services/
│       ├── api.ts                 Typed API client (auth, flows, run, resume)
│       ├── runPoller.ts           Polls /run/{jobId} → live overlay + trace wiring
│       └── langfuse.ts            Canvas event instrumentation
│
├── adapter/                     ← FastAPI backend
│   ├── main.py                    /health, /runtimes, /compile; startup secret validation
│   ├── run_api.py                 /run, /run/{id}/resume — async execution + Langfuse traces
│   ├── flows_api.py               /flows CRUD + versioning
│   ├── auth.py                    /auth — JWT register/login/me
│   ├── validate.py                validate_spec() — structural checks + fn_ref allowlist
│   ├── db.py                      SQLAlchemy async models (users, flows, flow_versions)
│   ├── rate_limit.py              Shared slowapi limiter (proxy-aware)
│   ├── langgraph_adapter.py       LangGraph codegen — all 14 nodes
│   ├── crewai_adapter.py          CrewAI codegen — all 14 nodes
│   ├── mastra_adapter.py          Mastra TypeScript codegen
│   ├── litellm_config.yaml        LiteLLM proxy config + Langfuse callback
│   ├── requirements.txt
│   ├── requirements-test.txt        pytest + httpx + anyio (not installed in prod Docker image)
│   └── tests/                   ← Adapter test suite (pytest + httpx)
│       ├── conftest.py            Fixtures: in-memory SQLite, TestClient, auth helpers
│       ├── test_auth.py           Register, login, me, password policy
│       ├── test_flows.py          CRUD, versioning, user isolation
│       └── test_spec_and_compile.py  validate_spec, fn_ref allowlist (compile + run), headers
│
├── infra/
│   └── postgres-init.sql          Creates 'langfuse' and 'litellm' databases on first boot
│
├── scripts/
│   └── check-schema-sync.mjs      Verifies canvas schema exports match canonical spec
│
├── docker-compose.yml             All 8 services — canvas, adapter, postgres, litellm,
│                                  clickhouse, redis, langfuse, langfuse-worker
├── .env.example                   All required env vars with generation hints
├── pytest.ini                     Pytest config (asyncio_mode=auto)
├── CONTRIBUTING.md
└── LICENSE                        Apache 2.0
```

> **`spec/schema.ts` vs `src/spec/schema.ts`** — `spec/schema.ts` is the canonical schema published as `@itsharness/flow-spec`. The canvas copy omits `.refine()` on individual node types (required by Zod's `z.discriminatedUnion()`). When the spec changes, update both and run `npm test`. CI enforces sync with `node scripts/check-schema-sync.mjs`.

---

## The spec — `@itsharness/flow-spec`

**Current version:** `0.2.0` · **RFC:** closed — see [`docs/adr/`](./docs/adr/)

### The 14 node types

| Node | What it does | Runtime support |
|---|---|---|
| `input` | Flow entry point; declares output schema | All |
| `output` | Flow exit point; optional exit code | All |
| `llm_call` | Single LLM invocation — structured output, validator, fail_branch | All |
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
| `agent_debate` | Multi-agent conversation loop with termination condition | Others: synthesised |

### Key field semantics (ADR-001)

These four decisions are codified in [`docs/adr/001-codegen-field-semantics.md`](./docs/adr/001-codegen-field-semantics.md).

| Field | Semantics |
|---|---|
| `output_key` | Direct state-dict write: node returns `{output_key: result}`. If absent on `llm_call`, result is discarded (canvas warns). |
| `query_expr` / `key_expr` / `value_expr` | Bare JSONPath selectors (`$.state.field`), resolved by `_resolve(state, expr)` in all adapters. Not mustache templates. |
| `context_from` | CrewAI → `Task.context=[...]`. LangGraph → comment annotation (shared state is already implicit). Mastra → step input mapping. |
| `memory_write.tier` | CrewAI → `XXXMemory()` instances added to `Crew()` constructor. Other adapters → comment-only hint. |

### `fn_ref` format and security

Node types that accept `fn_ref` (`transform`, `parallel_join`, `condition`, `agent_debate`) and local `tool_invoke` references inject those values into `importlib.import_module()` in generated code. All `fn_ref` values are validated against a strict allowlist at **every entry point** — `/compile`, `/flows`, and `/run` — before reaching any codegen or `exec()` call:

- **Format:** `module.path:function_name` — dotted Python identifier path, colon, identifier
- **npm format:** `@scope/package/export` — for npm package references (no colon)
- **Local format:** `./path/to/file:fn` — at most one colon
- **Rejected:** path traversal (`../`), shell special characters (`;`, `|`, `&`, `` ` ``, `$`, spaces), multiple colons, parentheses

Any non-conforming `fn_ref` returns a 400 error before any code is generated or executed.

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
    { "id": "start",  "type": "input",    "output_schema": { "type": "object", "properties": { "question": { "type": "string" } } } },
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

| Flow | Adapter | Exercises |
|---|---|---|
| [01 — RAG Agent](./flows/01-rag-agent-flow.json) | LangGraph | `memory_read` semantic, `transform` fn_ref, vector + kv stores |
| [02 — Content Moderation + HITL](./flows/02-content-moderation-hitl-flow.json) | Mastra | `llm_call` structured output, `condition`, `hitl_breakpoint` |
| [03 — Parallel Risk Assessment](./flows/03-parallel-risk-assessment-flow.json) | CrewAI | `parallel_fork/join`, `agent_role` ×3, `memory_access: "isolated"` |
| [04 — Research Crew](./flows/04-research-crew-flow.json) | CrewAI | `context_from` on edges, `memory_access: "shared"`, `tool_approval: "human"` |
| [05 — Debate Agent + A2A](./flows/05-debate-agent-a2a-flow.json) | MS Agent Framework | `agent_debate`, `runtime_support` overrides, full `a2a_config` |

---

## The canvas

**Authoring**
- All 14 node types with per-type config panels — every spec field editable
- Drag-to-add from node palette, drag-to-connect between handles
- Click any edge to edit `label` and `context_from`
- Auto-layout (dagre LR), undo/redo (50 steps), keyboard shortcuts
- Runtime compatibility badges per node (LG / CR / MA)
- Cmd+K command palette, annotation sticky notes, edge midpoint insert, flow version diff

**Validation**
- Zod + cross-ref validation on every export — errors shown inline
- ADR-001 authoring warnings: `llm_call` without `output_key`, `context_from` to node with no `output_key`
- Problems panel with clickable links to offending nodes

**Persistence**
- Every save → version row in Postgres; restore from library panel
- Auto-save to localStorage for pre-auth sessions

**Execution overlay**
- Per-node status: pending (dimmed) → running (blue pulse) → paused (amber pulse) → done (green) → error (red)
- Per-node timing (ms) and token count badge
- "View trace →" link after run completes, opening the Langfuse trace in a new tab

**HITL pause/resume**
- Paused node gets amber ring; "Flow paused" toast appears
- Side panel shows the node's prompt and editable resume fields
- Resume button → `POST /run/{job_id}/resume` → graph continues from checkpoint
- Multiple sequential HITL nodes work; each interrupt cycles through the same mechanism

---

## The adapters

### Authenticate first

All adapter endpoints require a JWT. Obtain one by registering an account:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "YourPassword1"}' | jq -r .token)
```

Or log in if already registered:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "YourPassword1"}' | jq -r .token)
```

Passwords must be at least 8 characters and contain at least one letter and one digit.

### Compile a flow

Requests wrap the spec in `{"spec": { ...flow JSON... }}`.

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

# Mastra
curl -s -X POST "http://localhost:8000/compile?runtime=mastra" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/02-content-moderation-hitl-flow.json)}" | jq -r .code
```

The `runtime` param is optional — if omitted the adapter uses `runtime_hints.preferred_adapter` from the spec, defaulting to `langgraph`.

### Adapter coverage

| Runtime | Status | Notes |
|---|---|---|
| **LangGraph** · Python · MIT | ✅ Full | All 14 nodes · `@observe` trace + child spans per node · HITL via `interrupt()` |
| **CrewAI** · Python · MIT | ✅ Full | All 14 nodes · `context_from→Task.context` · tier-aware `Crew()` memory |
| **Mastra** · TypeScript · Apache 2 | ✅ Codegen | All 14 nodes · `suspend()/resume()` for HITL · execution requires a Node.js runtime |
| **MS Agent Framework** | ⬜ Planned | `agent_debate→GroupChat`, `nodes→KernelProcessStep` — spec enum present, no adapter yet |

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

Execution is async — poll `GET /run/{job_id}` for status. The job store is in-memory and single-process; do not set `WEB_CONCURRENCY > 1` (the adapter exits with an error if you do). Persistent job storage is planned for Phase 3.

---

## Observability

### Stack

```
ClickHouse 24.3    → trace + analytics storage
Redis 7            → Langfuse ingestion queue
Langfuse 3 web     → UI + API  (http://localhost:3001)
Langfuse 3 worker  → async trace persistence to ClickHouse
```

All started automatically with `docker compose up`.

### What's traced

| Source | Langfuse content |
|---|---|
| **Job runners** | One trace per run (`crewai-flow-run` / `langgraph-flow-run`) via `@observe` decorator |
| **Node execution** | Child OTel span per node — name, timing, output keys (LangGraph) |
| **CrewAI tasks** | Per-task token usage in node events + Langfuse span |
| **LiteLLM** | Every LLM call — model, tokens, cost, latency — via automatic Langfuse callback |
| **Canvas** | Session events (flow opened, compiled, run started/done) linked to the active execution trace |

### Enable canvas tracing

Add to `.env.local` (Vite reads this automatically in dev mode):

```bash
VITE_LANGFUSE_ENABLED=true
VITE_LANGFUSE_PUBLIC_KEY=<same as LANGFUSE_PUBLIC_KEY in .env>
VITE_LANGFUSE_HOST=http://localhost:3001
```

---

## API reference

All endpoints except `/health` and `/runtimes` require `Authorization: Bearer <token>`. Request bodies that include a spec use `{"spec": { ...flow JSON... }}`.

```
POST /auth/register               Create account → JWT  (201)
POST /auth/login                  Login → JWT
GET  /auth/me                     Current user

GET  /flows?limit=50&offset=0     List user's flows (paginated, max 200 per page)
POST /flows                       Save / upsert flow (auto-versions, validates spec)
GET  /flows/{id}                  Current spec
DELETE /flows/{id}                Delete flow + all versions
GET  /flows/{id}/versions         Version history — newest first, paginated
GET  /flows/{id}/versions/{v}     Specific version spec
POST /flows/{id}/versions/{v}/restore  Restore version (creates a new version entry)

GET  /health                      Adapter status + version (no auth)
GET  /runtimes                    Available runtimes + support matrix (no auth)
POST /compile?runtime=X           Spec → compiled code  (30 req/min)

POST /run?runtime=X               Execute flow async → {job_id}  (20 req/min)
GET  /run/{job_id}                Job status, node_events, trace_id, trace_url
POST /run/{job_id}/resume         Resume a paused HITL flow
```

### Rate limits

| Endpoint | Limit |
|---|---|
| `POST /auth/register` | 5 / minute |
| `POST /auth/login` | 10 / minute |
| `POST /compile` | 30 / minute |
| `POST /run` | 20 / minute |

Limits are keyed by client IP. Set `TRUST_PROXY=true` (the default) when running behind nginx or a cloud load balancer so the adapter reads `X-Real-IP` / `X-Forwarded-For`. Set `TRUST_PROXY=false` when the adapter is exposed directly to the internet.

---

## Security model

### Authentication
- JWTs signed with `HS256`. Every protected endpoint requires a valid, non-expired token.
- Tokens have a configurable TTL (`JWT_TTL_DAYS`, default 30 days). There is currently no server-side revocation; log-out is client-side only. This is planned for Phase 3 alongside team RBAC.
- Login always runs bcrypt regardless of whether the email exists, preventing timing-based user enumeration.

### `fn_ref` validation
Generated code is executed with `exec()`. Rather than attempting full sandboxing, `fn_ref` values are validated at **all three** entry points (`/compile`, `/flows`, `/run`) against a strict allowlist regex before reaching any codegen or `exec()` call. Path traversal (`../`), shell special characters, and multiple colons are all rejected with a 400 error.

### Request limits
- Request body size is capped at `MAX_BODY_BYTES` (default 1 MB) to prevent large-spec denial-of-service.
- Rate limits on auth, compile, and run endpoints via slowapi.

### Secret validation
The adapter inspects all required secrets at startup and exits immediately if any are missing or contain known placeholder substrings (e.g. `REPLACE_ME`, `REPLACE_WITH_REAL_SECRET`). Substring matching is used rather than exact matching, so prefixed placeholders like `pk-lf-REPLACE_ME` are caught too. A warning is also emitted for optional Langfuse keys that contain placeholder values.

### Response headers
Every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.

### Container hardening
Both `Dockerfile.adapter` and `Dockerfile.canvas` run as non-root users, reducing the blast radius of any exec-level vulnerability.

---

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT signing key — `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | ✅ | Postgres password — `openssl rand -base64 24` |
| `LITELLM_MASTER_KEY` | ✅ | LiteLLM proxy master key |
| `LANGFUSE_ADMIN_EMAIL` | ✅ | Langfuse admin email (set before first boot) |
| `LANGFUSE_ADMIN_PASSWORD` | ✅ | Langfuse admin password |
| `LANGFUSE_NEXTAUTH_SECRET` | ✅ | `openssl rand -base64 32` |
| `LANGFUSE_SALT` | ✅ | `openssl rand -base64 32` |
| `LANGFUSE_ENCRYPTION_KEY` | ✅ | 64 hex chars — `openssl rand -hex 32` |
| `CLICKHOUSE_PASSWORD` | ✅ | ClickHouse password |
| `OPENAI_API_KEY` | recommended | Required for LLM nodes using OpenAI models |
| `ANTHROPIC_API_KEY` | optional | For Anthropic models via LiteLLM |
| `LANGFUSE_PUBLIC_KEY` | optional | Enables Langfuse tracing — must match key provisioned in Langfuse. Adapter warns at startup if set to a placeholder value. |
| `LANGFUSE_SECRET_KEY` | optional | Required when `LANGFUSE_PUBLIC_KEY` is set. Same placeholder check applies. |
| `CORS_ORIGINS` | optional | Comma-separated allowed origins (default: `http://localhost:3000,http://canvas:3000`) |
| `JWT_TTL_DAYS` | optional | Token lifetime in days (default: `30`) |
| `MAX_BODY_BYTES` | optional | Max request body size (default: `1048576` — 1 MB) |
| `JOB_TTL_HOURS` | optional | Hours before completed jobs are evicted from memory (default: `4`) |
| `TRUST_PROXY` | optional | `true` (default) trusts `X-Real-IP`/`X-Forwarded-For`; set `false` if adapter is internet-facing |
| `WEB_CONCURRENCY` | optional | Must be `1` — job store is in-memory (adapter exits if > 1) |

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0 — Spec design** | Primitive extraction · node taxonomy · spec schema v0.2 · 5 reference flows · RFC closed (ADR-001) | ✅ Complete |
| **1 — Canvas + adapters** | XYFlow canvas · 14 nodes · Zod validation · LangGraph + CrewAI + Mastra adapters · auth · versioning · live overlay | ✅ Complete |
| **2 — Observability + HITL** | HITL pause/resume UI · Langfuse self-host (ClickHouse + Redis) · OTel traces + node spans · token counts · LiteLLM cost tracking | ✅ Complete |
| **3 — Teams + eval** | Team RBAC · JWT revocation · eval integration (DeepEval + Ragas) · prompt versioning · component marketplace · A2A endpoint scaffolding · Postgres-backed job store · Alembic migrations | ⬜ Planned |
| **4 — Enterprise + collab + MS** | Real-time collaborative canvas (Yjs) · MS Agent Framework adapter · SSO · on-prem Helm chart · `@itsharness/canvas` npm package | ⬜ Planned |

---

## Key design decisions

**TypeScript on XYFlow, not Python on LangFlow.** LangFlow's canvas wires components; a harness needs to author state machines. XYFlow delivers the correct canvas model with a single-language stack and a future embeddable package.

**Neutral spec IR as the anchor.** The canvas emits a neutral JSON spec. Adapters translate it. Swapping runtimes means updating one adapter file. Canvas, versioning, RBAC, eval, and collaboration are fully decoupled from runtime choice.

**Langfuse (MIT, self-hosted) over LangSmith.** LangSmith is proprietary SaaS. Langfuse is MIT, self-hostable, OTel-compatible. The Langfuse Python SDK v4 uses OTel as its native transport, making per-node child spans straightforward via `contextvars.copy_context().run()` into the thread pool.

**ADR-001 as the spec-to-adapter contract.** Four field semantics were left open during spec design. Closing them via ADR rather than schema change means zero breaking changes and a permanent reference for future adapter authors.

**`fn_ref` allowlist over sandboxing.** Generated code is exec'd directly. Rather than attempting full sandboxing (complex, escape-prone), `fn_ref` values are validated against a strict allowlist regex at every entry point (`/compile`, `/flows`, `/run`) before reaching any codegen or exec() call.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
