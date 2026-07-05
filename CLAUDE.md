# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Start the stack
```bash
./scripts/setup-env.sh   # first-time only — generates secrets, writes .env
docker compose up        # all 9 services (canvas :3000, adapter :8000, Langfuse :3001)
```

### Frontend (canvas + packages)
```bash
npm run dev              # Vite dev server → localhost:3000
npm test                 # Vitest — schema + store tests (no server needed)
npm run lint             # ESLint (0 warnings allowed)
npm run typecheck        # tsc --noEmit
node scripts/check-schema-sync.mjs   # verify the 3 schema copies are in sync
```

### Adapter (Python)
```bash
# All tests use in-memory SQLite — no running stack needed
pytest adapter/tests/ -v                          # full suite (470 tests)
pytest adapter/tests/test_harness_p*.py -v --noconftest   # harness unit tests only
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_integration_*.py adapter/tests/test_harness_e2e.py adapter/tests/test_harness_invariants.py -v --noconftest
pytest adapter/tests/test_maf_adapter.py -v      # single file

# Linting
ruff check adapter/
ruff format adapter/
```

### Schema changes
When editing `spec/schema.ts`, you must sync three copies and regenerate:
1. `spec/schema.ts` — canonical source of truth
2. `src/spec/schema.ts` — canvas copy (omit `.refine()` calls on union members)
3. `packages/canvas/src/spec/schema.ts` — package copy (same rule)
4. Regenerate `spec/schema.json`: `cd spec && npm run gen:json-schema`
5. Add entry to `spec/CHANGELOG.md`

### Code sync to containers
Harness source files are **not volume-mounted**. After editing Python files in `adapter/`, sync to the running container:
```bash
docker cp adapter/harness/. buildaharness-adapter-1:/app/harness/
docker restart buildaharness-adapter-1
```

### Running coaching sessions
```bash
python3 agents/coaching/run_coaching_turns.py                     # default persona (alex_imposter_syndrome)
python3 agents/coaching/run_coaching_turns.py --persona <id>      # specific persona
python3 agents/coaching/run_coaching_turns.py --list              # list personas
python3 agents/coaching/generate_html_report.py <session-id>      # regenerate HTML from saved JSON
python3 agents/coaching/seed_coaching_kb.py                       # seed Qdrant coaching KB
```
Results saved to `agents/coaching/reports/<session-id>.json` and `.html`.

Personas live in `agents/coaching/personas/`, prompts in `agents/coaching/prompts/`.

## Architecture

### The core abstraction
**FlowSpec** (JSON, v1.0.0) is the neutral IR that decouples authoring from execution:
```
Canvas (React + XYFlow) → FlowSpec → Adapters → LangGraph / CrewAI / Mastra / MAF → Langfuse
```
The spec is the contract. The canvas authors it. Adapters compile it. The adapter API executes it.

### Services
| Service | Port | Purpose |
|---|---|---|
| `canvas` | 3000 | React + Vite dev / nginx prod |
| `adapter` | 8000 | FastAPI — compile, run, deploy, auth |
| `mastra-runner` | 4000 | Node.js sidecar — Mastra execution sandbox |
| `postgres` | 5432 | Flows, jobs, teams, orgs, harness state |
| `redis` | 6379 | JWT blocklist (DB 1) + Langfuse BullMQ (DB 0) |
| `litellm` | 4000 | LLM proxy — all model calls route through here |
| `langfuse-web` | 3001 | Observability UI |

### Adapter layer (`adapter/`)
- `main.py` — FastAPI app, mounts all routers
- `langgraph_adapter.py`, `crewai_adapter.py`, `mastra_adapter.py`, `maf_adapter.py` — one compiler per runtime; each generates executable code from a FlowSpec
- `run_api.py` — job queue, polling, HITL resume
- `harness/` — the 11-layer reasoning and control architecture (see below)
- `agents/coaching/` — Python subpackage: `tools.py`, `utils.py`, `mcp_server.py`, `data/`
- `coaching_tools.py`, `coaching_utils.py`, `coaching_mcp_server.py` — backward-compat shims (re-export from `agents/coaching/`)

All LLM calls route through LiteLLM (`:4000`). `fn_ref` values are validated against an allowlist at `/compile`, `/flows`, and `/run` before any codegen or `exec()`.

### Harness layer (`adapter/harness/`)
The 11 layers make agents reliable. Key files:

| Layer | Files |
|---|---|
| World Model | `world_model.py`, `world_model_ops.py`, `staleness.py` |
| Evidence & Reasoning | `evidence.py`, `tool_reliability.py`, `tool_manifest.py` |
| Hypothesis | `hypothesis.py` |
| Contradiction | `contradiction.py`, `belief_graph.py` |
| Diagnostics | `diagnostics.py` |
| Control State | `control_state.py` — 5-tier resolver → NORMAL / CAUTIOUS / BLOCKED |
| Planning | `task_graph.py`, `parallel_merge.py` |
| Execution | `execution.py`, `voi.py`, `risk.py`, `review_gate.py` |
| Verification | `verification.py` — 9 layers |
| Recovery | `recovery.py`, `replanning.py`, `memory.py` |
| Reviewer Pass | `reviewer.py` — 3-lens review (consistency, adversarial, abstraction fit) |

`loop.py` is the main harness iteration loop. `state_store.py` is the `HarnessRunState` dataclass persisted to Postgres.

10 architectural invariants are permanently enforced by `adapter/tests/test_harness_invariants.py` — these are a CI gate.

### Canvas / frontend (`src/`)
- `src/spec/schema.ts` — canvas working copy of the FlowSpec Zod schema
- `src/spec/examples.ts` — reference flows loaded into the canvas (including `coaching-agent-flow`)
- `src/store/` — Zustand store for canvas state
- `src/components/` — React components, including `DiagnosticsPanel.tsx` for live harness sub-dimensions

### npm packages (`packages/`)
| Package | Purpose |
|---|---|
| `@buildaharness/canvas` | Embeddable React canvas — context-scoped Zustand store, safe to mount multiple instances |
| `@buildaharness/harness` | TS implementation of the 11-layer harness, mirroring Python's state structures. `HarnessRuntime.run()`/`.resume()` is a resumable async engine — see `packages/harness/README.md` |
| `@buildaharness/runtime` | Framework-agnostic client-side FlowSpec executor, plus storage (`InMemoryAdapter`, `IndexedDBAdapter`/Dexie, `DexieExperienceStore`) and `LLMClient` — see `packages/runtime/README.md` |
| `@buildaharness/react` | `useHarness()` hook wrapping `@buildaharness/runtime` |
| `@buildaharness/proxy` | LLM key proxy — Cloudflare Worker or Docker |
| `@buildaharness/personal-assistant` | Everyday-use chat assistant running the full harness client-side every turn, with IndexedDB/Dexie-backed memory and crash-mid-turn resume — see `packages/personal-assistant/README.md` |

### Schema sync rule
`spec/schema.ts` (root) is the canonical source. `src/spec/schema.ts` and `packages/canvas/src/spec/schema.ts` are copies that must stay in sync. The copies drop `.refine()` calls because `z.discriminatedUnion()` requires bare `ZodObject` members, not `ZodEffects`. Cross-field validation is handled by `src/spec/validation.ts` instead.

### Coaching agent flow
The coaching agent (`coaching-agent-flow` in `src/spec/examples.ts`) is a multi-turn harness that runs via the LangGraph adapter. It uses:
- `adapter/agents/coaching/tools.py` — tool implementations (RAG retrieval, session state, etc.)
- `adapter/agents/coaching/utils.py` — coaching utilities (technique lookup, turn state, etc.)
- `adapter/agents/coaching/data/` — `coaching_domains.json`, `coaching_schools.json`
- `agents/coaching/personas/` — JSON persona files used by `run_coaching_turns.py`
- `agents/coaching/prompts/` — system prompt files
- `agents/coaching/scripts/` — helper scripts (`stream_pretty.py`, `parse_claude_result.py`, etc.)
- `adapter/harness/` primitives: `TurnContextBootstrap` (G-2), `FeedbackPreferenceExtractor` (G-3), `MultiSourceDiversityReducer` (G-4), `TaxonomyClassifier` (G-5), `SessionCloseFactory` (G-6)
- Coaching KB seeded via `agents/coaching/seed_coaching_kb.py` into the vector store

**fn_ref backward compatibility**: FlowSpecs reference `coaching_tools` and `coaching_utils` as bare module names. The shims at `adapter/coaching_tools.py` and `adapter/coaching_utils.py` re-export everything from the subpackage so existing fn_refs continue to work without modification.
