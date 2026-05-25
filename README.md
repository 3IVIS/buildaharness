# itsharness

**Build, run, and observe AI agent workflows.**

Draw a flow on the canvas → export a runtime-agnostic spec → compile to your framework → run, trace, debug, and deploy — all from one tool.

```
flow.json  →  [ langgraph adapter ]  →  Python / LangGraph
           →  [ crewai adapter ]     →  Python / CrewAI
           →  [ mastra adapter ]     →  TypeScript / Mastra
           →  [ maf adapter ]        →  Python / MS Agent Framework
           →  [ REST endpoint ]      →  POST /flows/{id}/invoke
           →  [ MCP tool ]           →  Claude Desktop + any MCP client
           →  [ A2A agent ]          →  any A2A-compatible runtime
```

**Current version:** v0.8.0 — all four phases complete. 240 items shipped.

---

## Quick start

### 1. Run setup

```bash
./setup-env.sh
```

That single command does everything needed before `docker compose up`:

- Generates all cryptographic secrets and writes them into `.env` (replacing any placeholders from `.env.example` in-place — no duplicate lines)
- Prompts for the two values that can't be auto-generated: your Langfuse admin email and password
- Optionally prompts for LLM API keys (OpenAI / Anthropic) — press Enter to skip and add them later
- Writes `.env.local` for the Vite canvas dev server
- Verifies every required secret with `scripts/check-env.sh` before proceeding
- Then asks (separately, each with Y/n) whether to also:
  - Create the Python virtual environment and install adapter dependencies
  - Generate `mastra-runner/package-lock.json` (requires Node.js, one-time)
  - Start the full Docker stack immediately

**Re-run safe** — if a secret is already set to a real value, `setup-env.sh` keeps it and skips it. Run it again any time to repair a partially-filled `.env` or add secrets that were introduced after your initial setup.

### 2. Start the stack

If you didn't start it inside `setup-env.sh`:

```bash
docker compose up
```

| Service | URL |
|---|---|
| Canvas | http://localhost:3000 |
| Adapter API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

Nine services start: canvas, adapter, mastra-runner, postgres, redis, clickhouse, litellm, langfuse-web, langfuse-worker.

> **Startup errors?** See [docs/troubleshooting.md](./docs/troubleshooting.md). The most common causes are a stale Postgres volume (`./scripts/reset-volumes.sh` fixes it) or a secret that's wrong length — `bash scripts/check-env.sh` will identify it exactly.

**Real-time collaboration** is opt-in — see [docs/collab.md](./docs/collab.md).

**On-prem / Kubernetes** — see [docs/deployment.md](./docs/deployment.md).

### Check secrets any time

```bash
bash scripts/check-env.sh
```

Checks every required secret is present, non-placeholder, and — for `LANGFUSE_ENCRYPTION_KEY` specifically — exactly 64 hex characters. Exits 0 if all good, 1 with a clear error for each failing key.

### Without Docker

```bash
./setup-env.sh                  # handles secrets, venv, and deps
source adapter/.venv/bin/activate
npm install && npm run dev       # canvas → http://localhost:3000
cd adapter && python main.py     # adapter → http://localhost:8000
```

### Tests

```bash
npm test                         # Vitest — validates all 5 reference flows
pytest adapter/tests/ -v         # adapter unit + integration suite
pytest adapter/tests/test_maf_adapter.py -v   # MAF adapter suite (742 tests)
```

---

## What it does

- **Draw** — 14 node types on a visual canvas. Every spec field is directly editable.
- **Own the spec** — the canvas emits a versioned, runtime-agnostic JSON spec you control.
- **Compile** — one API call transforms the spec into runnable code for your chosen framework.
- **Run and observe** — live node overlays, per-node token counts, Langfuse trace links, HITL pause/resume.
- **Deploy** — one click publishes the flow as a REST endpoint, MCP tool, and A2A agent simultaneously.
- **Collaborate** — real-time multi-user editing with Yjs CRDT, live cursors, and offline persistence.
- **Embed** — drop the canvas into your own portal with the `@itsharness/canvas` npm package.

**The spec is the contract. The canvas is the editor. The adapters are the compilers.**

---

## Repository structure

```
itsharness/
│
├── spec/                        ← @itsharness/flow-spec (published npm)
│   ├── schema.ts                  Canonical Zod schema — source of truth
│   ├── schema.json                Derived JSON Schema
│   └── CHANGELOG.md
│
├── flows/                       ← 5 reference flows (JSON)
│
├── packages/
│   └── canvas/                  ← @itsharness/canvas (published npm)
│       ├── src/ItsHarnessCanvas.tsx
│       ├── src/store/create.ts    Per-instance Zustand store (no singleton)
│       ├── vite.config.lib.ts     Lib build → ESM + CJS + types
│       └── README.md
│
├── src/                         ← Canvas app (React + TypeScript + XYFlow)
│   ├── collab/                    Yjs CRDT real-time collaboration layer
│   ├── spec/                      Canvas schema + validation
│   ├── store/index.ts             Zustand store
│   ├── canvas/nodes/              14 node components
│   └── components/                Sidebar, ConfigPanel, deploy panels, HITL
│
├── adapter/                     ← FastAPI backend (v0.8.0)
│   ├── langgraph_adapter.py       LangGraph codegen — all 14 nodes
│   ├── crewai_adapter.py          CrewAI codegen — all 14 nodes
│   ├── mastra_adapter.py          Mastra TypeScript codegen
│   ├── maf_adapter.py             MS Agent Framework codegen — all 14 nodes
│   ├── sso_auth.py                OIDC + SCIM 2.0
│   ├── migrations/versions/       Alembic migrations 0001–0008
│   └── tests/                     Pytest suite
│
├── mastra-runner/               ← Node.js sidecar for Mastra execution
│
├── deploy/helm/itsharness/      ← On-prem Helm chart (v0.1.0)
│
├── .github/workflows/
│   ├── ci.yml                     PR checks: lint · typecheck · tests · canvas-package build
│   ├── eval.yml                   Spec-validation · debate quality metrics (nightly + push)
│   ├── deploy.yml                 5-stage: test → build → staging → prod → post-eval
│   ├── publish-spec.yml           Publishes @itsharness/flow-spec on spec-v* tags
│   └── publish-canvas.yml         Publishes @itsharness/canvas on canvas-v* tags
│
├── docs/
│   ├── architecture.md            System design, data flows, key decisions
│   ├── api.md                     Full API reference
│   ├── collab.md                  Real-time collaboration setup and internals
│   ├── deployment.md              Docker, Helm, SSO/OIDC, env var reference
│   └── adr/001-codegen-field-semantics.md
│
├── docker-compose.yml           ← 9 services
├── docker-compose.collab.yml    ← y-websocket overlay (opt-in collab)
└── CONTRIBUTING.md
```

> **`spec/schema.ts` vs `src/spec/schema.ts`** — `spec/schema.ts` is the canonical published schema. The canvas copy omits `.refine()` calls required by Zod's discriminated union. When the spec changes, update both and run `scripts/check-schema-sync.mjs`.

---

## The spec — `@itsharness/flow-spec`

**Current version:** `0.2.0` · **RFC:** closed — field semantics in [`docs/adr/001`](./docs/adr/001-codegen-field-semantics.md)

### Node types

| Node | What it does | Runtime support |
|---|---|---|
| `input` | Flow entry point | All |
| `output` | Flow exit point | All |
| `llm_call` | LLM invocation — structured output, validator, fail_branch, managed prompts | All |
| `tool_invoke` | Named tool from the flow's `tools[]` registry | All |
| `condition` | Branching — JSONPath or `fn_ref` | All |
| `parallel_fork` | Fan-out to N concurrent branches | All |
| `parallel_join` | Fan-in — `merge` / `append` / `fn_ref` reducer | All |
| `hitl_breakpoint` | Suspend; wait for a typed human resume payload | All |
| `memory_read` | Read from key-value or semantic store | All |
| `memory_write` | Write to a named store | All |
| `subgraph` | Embed another flow as a node | LG/MA: full · CR: partial |
| `transform` | State transform — mapping or `fn_ref` | All |
| `agent_role` | Execute an agent persona from `agents[]` | CR: native · others: synthesised |
| `agent_debate` | Multi-agent loop with termination condition | MAF: native · others: synthesised |

### Example flows

| Flow | Runtime | Exercises |
|---|---|---|
| [01 — RAG Agent](./flows/01-rag-agent-flow.json) | LangGraph | `memory_read` semantic, `transform` fn_ref |
| [02 — Content Moderation + HITL](./flows/02-content-moderation-hitl-flow.json) | Mastra | `llm_call` structured output, `hitl_breakpoint` |
| [03 — Parallel Risk Assessment](./flows/03-parallel-risk-assessment-flow.json) | CrewAI | `parallel_fork/join`, `agent_role` ×3 |
| [04 — Research Crew](./flows/04-research-crew-flow.json) | CrewAI | `context_from` on edges, `tool_approval: "human"` |
| [05 — Debate Agent + A2A](./flows/05-debate-agent-a2a-flow.json) | MS Agent Framework | `agent_debate`, `a2a_config` |

### Adapter coverage

| Runtime | Status | Key notes |
|---|---|---|
| **LangGraph** · Python | ✅ Full | `@observe` trace + child spans · HITL via `interrupt()` |
| **CrewAI** · Python | ✅ Full | `context_from → Task.context` · tier-aware `Crew()` memory |
| **Mastra** · TypeScript | ✅ Full | Node.js sidecar · `suspend()/resume()` HITL |
| **MS Agent Framework** · Python / semantic-kernel 1.x | ✅ Full | `AgentGroupChat` native · HITL via `_HitlPause` · OTel → Langfuse |

---

## Core workflows

### Compile a flow

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "YourPassword1"}' | jq -r .token)

curl -s -X POST "http://localhost:8000/compile?runtime=langgraph" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/01-rag-agent-flow.json)}" | jq -r .code
```

### Execute a flow

```bash
JOB=$(curl -s -X POST "http://localhost:8000/run?runtime=langgraph" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spec\": $(cat flows/01-rag-agent-flow.json)}" | jq -r .job_id)

curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8000/run/$JOB" \
  | jq '{status, trace_url}'
```

### Deploy a flow

```bash
# One-click deploy: REST + MCP + A2A simultaneously
curl -s -X POST "http://localhost:8000/deploy/my-flow" \
  -H "Authorization: Bearer $TOKEN"

# Invoke synchronously
curl -s -X POST "http://localhost:8000/flows/my-flow/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "What is the capital of France?"}}'
```

---

## The `@itsharness/canvas` package

The canvas is also published as a standalone npm package for embedding in your own tools:

```bash
npm install @itsharness/canvas
```

```tsx
import { ItsHarnessCanvas } from '@itsharness/canvas'
import '@itsharness/canvas/styles.css'

<ItsHarnessCanvas
  initialSpec={mySpec}
  onSpecChange={(updated) => save(updated)}
  onNodeSelect={(id) => setInspector(id)}
  execStats={runState.nodeStats}
  theme="dark"
/>
```

See [`packages/canvas/README.md`](./packages/canvas/README.md) for full props reference and usage patterns.

---

## Further reading

| Document | Contents |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | System design, service interactions, data flows, key decisions |
| [docs/api.md](./docs/api.md) | Full API reference — all endpoints, auth, error codes |
| [docs/collab.md](./docs/collab.md) | Real-time collaboration — setup, Yjs internals, env vars |
| [docs/deployment.md](./docs/deployment.md) | Docker, Helm, SSO/OIDC configuration, full env var reference |
| [docs/adr/001](./docs/adr/001-codegen-field-semantics.md) | Codegen field semantics — `output_key`, `*_expr`, `context_from`, `memory_write.tier` |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | Common startup errors — Postgres auth, Redis password, volume resets |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute — adapters, schema, canvas, migrations |
| [packages/canvas/README.md](./packages/canvas/README.md) | `@itsharness/canvas` usage and props |
| [spec/CHANGELOG.md](./spec/CHANGELOG.md) | Spec version history |

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
