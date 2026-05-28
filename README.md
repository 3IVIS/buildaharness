# Its Harness

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
./scripts/setup-env.sh
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

**Re-run safe** — if a secret is already set to a real value, `scripts/setup-env.sh` keeps it and skips it. Run it again any time to repair a partially-filled `.env` or add secrets that were introduced after your initial setup.

### 2. Start the stack

If you didn't start it inside `scripts/setup-env.sh`:

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
./scripts/setup-env.sh          # handles secrets, venv, and deps
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

### Diagnostics

| Script | What it checks |
|---|---|
| `bash scripts/verify_services.sh` | All containers running · healthchecks · HTTP endpoints · Redis / Postgres / Langfuse auth |
| `bash scripts/verify_llm.sh` | Ollama direct → LiteLLM proxy → adapter flow (3 independent layers) |
| `bash scripts/verify_hitl.sh` | HITL pause → resume → done for LangGraph, Mastra, MAF |
| `bash scripts/verify_observability.sh` | Langfuse trace confirmed for all 4 runtimes |
| `bash scripts/verify_prompts.sh` | Langfuse prompt API · adapter HTTP proxy · SDK resolve |

Set `TEST_EMAIL=... TEST_PASSWORD=...` to skip the interactive credentials prompt in any verify script.

---

## LLM provider setup

Its Harness routes all LLM calls through **LiteLLM** — a unified proxy that sits between the adapters and the actual model providers. You pick a model name in your flow spec; LiteLLM sends it to the right provider.

```
flow spec  →  adapter  →  LiteLLM proxy  →  OpenAI   (gpt-4o, gpt-4o-mini)
                       ↗                 →  Anthropic (claude-sonnet, claude-haiku, claude-opus)
                       ↗                 →  Ollama    (mistral, qwen3, qwen2.5-coder)
```

### Quick reference — model names

| Model name in flow spec | Provider | Key required in `.env` |
|---|---|---|
| `gpt-4o` | OpenAI | `OPENAI_API_KEY` |
| `gpt-4o-mini` | OpenAI | `OPENAI_API_KEY` |
| `claude-sonnet` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-haiku` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-opus` | Anthropic | `ANTHROPIC_API_KEY` |
| `mistral` | Ollama (local) | none |
| `qwen3` | Ollama (local) | none |
| `qwen2.5-coder` | Ollama (local) | none |

> All four adapters (LangGraph, CrewAI, Mastra, MS Agent Framework) use the same routing — the model name in your spec determines the provider automatically.

---

### Option A — OpenAI

1. Add your key to `.env`:

   ```env
   OPENAI_API_KEY=sk-...
   ```

2. In your flow spec, set `model_defaults.model` or any `llm_call` node's `model` field:

   ```json
   { "model_defaults": { "model": "gpt-4o-mini" } }
   ```

3. Start the stack: `docker compose up`

---

### Option B — Anthropic (Claude)

1. Add your key to `.env`:

   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. In your flow spec, use a Claude model name:

   ```json
   { "model_defaults": { "model": "claude-sonnet" } }
   ```

3. Start the stack: `docker compose up`

That's it. LiteLLM handles the Anthropic API — no other changes needed.

---

### Option C — Local Ollama (no API keys required)

Run every adapter entirely offline against a local [Ollama](https://ollama.com) server. No OpenAI or Anthropic account needed.

#### Step 1 — Install Ollama

| Platform | Command |
|---|---|
| macOS | `brew install ollama` or download the [desktop app](https://ollama.com/download) |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Windows | Download the [installer](https://ollama.com/download/windows) |

#### Step 2 — Pull a model

```bash
ollama pull mistral:latest        # ~4 GB, fast — recommended for testing
# or
ollama pull qwen3:latest          # higher quality, larger
# or
ollama pull qwen2.5-coder:7b      # good for code-heavy flows
```

Check what you have: `ollama list`

#### Step 3 — Configure the Docker stack

Add two lines to your `.env` so the adapter and Mastra runner containers reach Ollama on your host:

```env
# .env — add these lines (or uncomment if already present)
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_API_KEY=ollama
```

> **`host.docker.internal`** is the Docker-internal hostname that resolves to your Mac or Linux host. On Linux, run `docker compose up` with `--add-host=host.docker.internal:host-gateway` if this hostname isn't available in your Docker version.

Then restart the adapter (or the whole stack) to pick up the new env vars:

```bash
docker compose up -d              # full stack
# or, if already running:
docker compose restart adapter mastra-runner
```

#### Step 4 — Run the adapter test

[`scripts/setup-ollama.sh`](./scripts/setup-ollama.sh) submits [`flows/06-ollama-simple-flow.json`](./flows/06-ollama-simple-flow.json) to all four adapters, polls for completion, and verifies each response mentions the test topic.

```bash
# Basic — mistral:latest, all 4 runtimes:
./scripts/setup-ollama.sh

# Different model:
./scripts/setup-ollama.sh qwen3:latest

# Different test topic:
./scripts/setup-ollama.sh mistral:latest "quantum computing"

# Single runtime only:
RUNTIME=langgraph ./scripts/setup-ollama.sh
RUNTIME=mastra    ./scripts/setup-ollama.sh

# Non-interactive / CI — skip the email prompt:
TEST_EMAIL=ci@example.com TEST_PASSWORD=CiPass99! ./scripts/setup-ollama.sh
```

**What you'll see:**

```
━━  Preflight  ━━
  ✓  Ollama is running at http://localhost:11434
  ✓  Model 'mistral:latest' is available
  ✓  Adapter v0.7.0 is running at http://localhost:8000

━━  Authentication  ━━
  Email:    you@example.com
  Password: ········
  ✓  Logged in as you@example.com

━━  Submitting jobs  ━━
  ✓  langgraph                       → 4f1a…
  ✓  crewai                          → 8c2b…
  ✓  microsoft_agent_framework       → d91e…
  ✓  mastra                          → 3f7c…

━━  Waiting for results  ━━
  ✓  langgraph                      done in 5s — topic verified ✓
     Photosynthesis is a process used by plants…
  ✓  mastra                         done in 12s — topic verified ✓
     Photosynthesis is a process used by plants…
  ✓  microsoft_agent_framework      done in 18s — topic verified ✓
     Photosynthesis is a process by which plants…
  ✓  crewai                         done in 28s — topic verified ✓
     Photosynthesis is a process used by plants…

━━  Summary  ━━
  ✓  langgraph                      PASS
  ✓  crewai                         PASS
  ✓  microsoft_agent_framework      PASS
  ✓  mastra                         PASS

  ✓  All 4 runtime(s) passed
```

#### Troubleshooting Ollama

| Symptom | Fix |
|---|---|
| `Ollama is not running` | Run `ollama serve` (or open the macOS app) |
| Model not found | Run `ollama pull mistral:latest` |
| Adapter returns wrong topic / empty result | Check `docker compose logs adapter --tail 30` — OPENAI_BASE_URL may not be set |
| `host.docker.internal` not resolving (Linux) | Add `--add-host=host.docker.internal:host-gateway` to the adapter's docker-compose service, or set `OPENAI_BASE_URL=http://172.17.0.1:11434/v1` |
| Timeout on Mastra | Mastra compiles TypeScript and spins up a vm.Module — allow 30-60 s for first run |

#### Without Docker (local dev)

```bash
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
cd adapter && uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
./scripts/setup-ollama.sh mistral:latest
```

---

### How it works under the hood

In Docker, the adapter and Mastra runner containers have:

```
OPENAI_BASE_URL = http://litellm:4000   (default — the LiteLLM proxy)
OPENAI_API_KEY  = <LITELLM_MASTER_KEY>  (authenticates to LiteLLM)
```

LiteLLM reads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the host `.env` to call the actual APIs. Every LLM call is also traced in Langfuse automatically.

When you set `OPENAI_BASE_URL` to an Ollama URL in `.env`, that value overrides the default, bypassing LiteLLM entirely and hitting Ollama directly.

**Adding a custom model:** edit [`adapter/litellm_config.yaml`](./adapter/litellm_config.yaml) and restart the `litellm` container:

```yaml
- model_name: my-model          # use this name in the flow spec
  litellm_params:
    model: openai/gpt-4.1       # or anthropic/..., ollama/..., etc.
    api_key: os.environ/OPENAI_API_KEY
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
├── flows/                       ← 11 flows (5 published reference + 6 working)
│   ├── 01–05-*.json               Published reference flows (see table below)
│   ├── 06-ollama-simple-flow.json   Single llm_call; no external deps — used by setup-ollama.sh
│   ├── 07-minimal-hitl-test-flow.json  No LLM; always pauses — used by verify_hitl.sh
│   ├── flow-plan-execute.json     Plan + Execute — clarify → plan → HITL → output
│   ├── flow-parallel-research.json  3 parallel researcher agents + join
│   ├── flow-llm-planner-meta.json  Meta-flow: LLM generates a FlowSpec
│   └── flow-research-write.json   Research + Write with parallel topics and HITL gate
│
├── scripts/                     ← Helper shell scripts (all run from project root)
│   ├── setup-env.sh               First-time setup — secrets, venv, Docker
│   ├── setup-ollama.sh            Test all 4 runtimes against local Ollama
│   ├── check-env.sh               Validate required secrets in .env
│   ├── reset-volumes.sh           Wipe Postgres / Redis / Clickhouse volumes
│   ├── run_langgraph.sh           Submit + poll a LangGraph job (HITL-aware)
│   ├── run_crewai.sh              Submit + poll a CrewAI job
│   ├── run_mastra.sh              Submit + poll a Mastra job (HITL-aware)
│   ├── run_maf.sh                 Submit + poll a MAF job (HITL-aware)
│   ├── verify_services.sh         Check all Docker services are healthy
│   ├── verify_llm.sh              Verify Ollama → LiteLLM → adapter LLM path
│   ├── verify_hitl.sh             HITL regression: pause → resume → done
│   ├── verify_observability.sh    Confirm Langfuse traces are written
│   └── verify_prompts.sh          Test Langfuse-managed prompt templates
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
| [06 — Ollama Simple](./flows/06-ollama-simple-flow.json) | All | Single `llm_call`; no external deps — used by `scripts/setup-ollama.sh` |
| [07 — Minimal HITL Test](./flows/07-minimal-hitl-test-flow.json) | LG / MA / MAF | No LLM; always pauses — used by `scripts/verify_hitl.sh` |
| [Plan + Execute](./flows/flow-plan-execute.json) | All | `hitl_breakpoint` ×2, `agent_role`, `llm_call` quality gates |
| [Parallel Research](./flows/flow-parallel-research.json) | All | `parallel_fork/join`, 3 concurrent `agent_role` researchers |
| [LLM Planner (meta-flow)](./flows/flow-llm-planner-meta.json) | All | `agent_role` generates a FlowSpec; `condition` retry loop |
| [Research + Write](./flows/flow-research-write.json) | All | `parallel_fork/join`, `hitl_breakpoint` quality gate, `transform` |

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
# The 'inputs' object seeds the flow's initial state.
# Keys must match the fields declared in the flow's state_schema.
JOB=$(curl -s -X POST "http://localhost:8000/run?runtime=langgraph" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"spec\":   $(cat flows/06-ollama-simple-flow.json),
    \"inputs\": {\"topic\": \"quantum computing\"}
  }" | jq -r .job_id)

# Poll for status + result
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8000/run/$JOB" \
  | jq '{status, result, trace_url}'
```

### Run a flow from the CLI

The `scripts/run_*.sh` scripts are an interactive wrapper: they prompt for credentials, submit the job, stream live node events, and handle HITL pauses — prompting for a JSON payload and resuming automatically.

```bash
# LangGraph (full HITL support)
bash scripts/run_langgraph.sh flow-plan-execute.json

# Mastra
bash scripts/run_mastra.sh flow-plan-execute.json

# Microsoft Agent Framework
bash scripts/run_maf.sh flow-plan-execute.json

# CrewAI (no API-level HITL — human_input=True runs inline)
bash scripts/run_crewai.sh flow-plan-execute.json
```

The first argument is the flow spec file (defaults to `flow-plan-execute.json`). Override the adapter URL with `BASE_URL=http://...`.

---

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
