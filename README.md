<div align="center">

# Its Harness

**Visual Canvas for AI Agent Harnesses**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/version-v0.8.0-brightgreen.svg)](https://github.com/3IVIS/itsharness/releases)
[![Status](https://img.shields.io/badge/status-public%20alpha-orange.svg)](https://github.com/3IVIS/itsharness)
[![GitHub Stars](https://img.shields.io/github/stars/3IVIS/itsharness?style=social)](https://github.com/3IVIS/itsharness/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/3IVIS/itsharness)](https://github.com/3IVIS/itsharness/issues)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/3IVIS/itsharness/blob/main/CONTRIBUTING.md)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

[English](README.md) | [中文](README_CN.md)

</div>

---

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

**Current version:** v0.8.0 — canvas, four framework adapters, and Langfuse observability complete.

---

## The bigger picture — what a full harness is

A workflow tells your AI what to do. A harness makes sure it actually does it.

The difference is not a matter of degree — it is architectural. A workflow routes prompts from node to node. A harness governs what the agent *believes*, what it is *allowed* to do, how it catches its own mistakes, and what it learns for next time. Its Harness is building toward that complete architecture: draw it on a canvas today, run it on any framework, and gain the full control layer as each phase lands.

### Where we are today vs the full target

| | Today — v0.8.0 | Target — Full Harness |
|---|---|---|
| Canvas | 14 node types | 24 node types (10 new harness nodes in P10) |
| Frameworks | LangGraph · CrewAI · Mastra · MAF | All four + harness-layer adapters |
| Observability | Langfuse traces for all 4 runtimes | Harness spans: world model, control state, verification, recovery |
| Reasoning | Prompt in → answer out | World model · beliefs · hypotheses · VOI-gated evidence |
| Control | None | 5-tier resolver · NORMAL / CAUTIOUS / BLOCKED |
| Verification | None | 9 layers · adversarial reviewer pass · pre-execution gate |
| Recovery | None | 6 named strategies · typed failure library · local/global replan |
| Memory | None | Budget tracking · journal · compression risk |
| Learning | None | Experience store — structural reuse across runs |

### The 11 architectural layers

The full harness is organised into 11 layers, each with a distinct responsibility:

| Layer | Responsibility |
|---|---|
| **Caller State** | Requirements, constraints, clarifications — mutable first-class object updated mid-run |
| **World Model** | Observations, beliefs, assumptions, contradictions — `generation_id` tracks every significant update |
| **Reasoning** | Evidence handling, hypothesis generation from four sources, VOI-gated evidence gathering |
| **Planning** | Task decomposition, scheduling, parallel concurrency with write-domain conflict detection |
| **Control** | Risk state management — five-tier resolver outputs `NORMAL` / `CAUTIOUS` / `BLOCKED` |
| **Execution** | Action selection and mutation — control state is the sole control input |
| **Verification** | 9-layer verification · adversarial reviewer pass · pre-execution review gate |
| **Policy** | Gate enforcement at decomposition, action selection, and post-execution |
| **Recovery** | Rollback and replanning — six named strategies · typed failure library |
| **Memory** | Context compression · journal retention policy · budget tracking |
| **Learning** | Experience store (optional) — structural reuse across runs, not just probability priors |

### The 22 nodes

The full harness executes a 22-node loop. Each node corresponds to a specific reasoning or control responsibility:

| # | Node | Layer | What it does |
|---|---|---|---|
| 1 | **Initialize** | Planning | Sets up all persistent state: world model, belief dep graph, hypothesis set, task graph, diagnostics, control state, memory budget |
| 2 | **Warm Start** | Learning | Loads reusable structures from the experience store (strategy priors, failure base rates, structural patterns) — no-op if unavailable |
| 3 | **Check Caller Updates** | Caller State | Non-blocking poll for mid-run constraint changes; full propagation to task graph and output contract if constraints changed |
| 4 | **Context Compression** | Memory | `compress_memory()` — tracks compressed structures and pruned regions separately; updates `completeness_flags` |
| 5 | **Gather Evidence** | Reasoning | Collects `Evidence(obs, reliability, source, type, freshness)` — observations never auto-promoted to conclusions |
| 6 | **Apply Tool Reliability** | Reasoning | Caps maximum conclusion reliability per tool given known scope limits; updates `verification_health.feasibility` |
| 7 | **Update World Model** | World Model | Reliability-weighted belief integration; `belief_dep_graph` propagation; `completeness_flags` updated |
| 8 | **Detect Contradictions** | World Model | Typed detection: `pairwise` · `set-level` · `temporal` · `abstraction` — four severity levels, three scopes |
| 9 | **Generate / Update Hypotheses** | Reasoning | Four structurally distinct sources; diversity enforcement (threshold 0.7); elimination policy with K-retention |
| 10 | **Update Diagnostics** | Control | Recomputes all four health vectors; `failure_mode_library.match()`; `dep_class_gap` advisory annotation |
| 11 | **Resolve Control State** | Control | Five implicit tiers in strict order → `NORMAL` / `CAUTIOUS` / `BLOCKED`; deadlock detection; `generation_id` stamped |
| 12 | **Update Task Graph** | Planning | Reflects new world model state; cycle detection; `abstraction_fit` recomputed on change |
| 13 | **Select Task** | Planning | `depends_on` resolution; pessimistic or optimistic concurrency from `conflict_probability_cache`; parallel branch merge at join |
| 14 | **Estimate Risk** | Execution | `LOW` / `MEDIUM` / `HIGH` — based on file centrality, change scope, module type |
| 15 | **Estimate VOI** | Reasoning | `VOI = expected_uncertainty_reduction × decision_impact`; verification adequacy critic prunes unavailable 9-layer checks |
| 16 | **Review Proposed Change** | Policy | Five-dimension pre-execution gate — task alignment, world model consistency, output contract, code quality, open hypotheses |
| 17 | **Execute** | Execution | Per-action reversibility strategy; tool workflow; tool errors become `Evidence(HIGH, SYSTEM_ERROR)` |
| 18 | **Verify** | Verification | 9 verification layers (pruned by `tool_availability_manifest`); adversarial pass if `HIGH` risk; `contract_shadow_check` |
| 19 | **Rollback + Replan** | Recovery | `rollback()` → `record_failure()` → strategy switch; six named strategies: `DIRECT_EDIT` · `TRACE_EXEC` · `BROADER_SEARCH` · `REIMPLEMENT` · `MINIMAL_FIX` · `ESCALATE` |
| 20 | **Escalate** | Caller State | Fires when `BLOCKED` or `cannot_make_progress()`; surfaces minimum information needed; full constraint propagation on human response |
| 21 | **Reviewer Pass** | Verification | Three lenses (implementer · reviewer · adversarial); adversarial prior seeded on causal proximity to success criteria |
| 22 | **Output Validation** | Verification | Full output contract check against current caller constraints — authoritative pass before return |

### The 11 implementation phases

The repository ships today as a working canvas-and-adapters tool. Every subsequent phase adds a layer of the full harness:

| Phase | Name | Focus |
|---|---|---|
| **P0** *(in progress)* | Foundation & State Architecture | FlowSpec extension, harness state model, `generation_id`, `completeness_flags`, health vectors |
| **P1** | Evidence & Reasoning | Evidence store, tool reliability envelopes, VOI estimation, hypothesis system |
| **P2** | World Model & Contradiction | Belief dep graph, typed contradiction detection, staleness sweep |
| **P3** | Diagnostics & Control State | Health vector computation, five-tier `resolve_control_state()`, deadlock detection |
| **P4** | Planning & Task Graph | Task graph (6-state), parallel write-domain conflict detection, `conflict_probability_cache` |
| **P5** | Execution & Verification | Pre-execution review gate, 9-layer verification, adversarial pass, reversibility strategy |
| **P6** | Recovery & Memory | Six named recovery strategies, typed failure library, context compression, journal retention |
| **P7** | Caller State & Escalation | Proactive mid-loop caller updates, `cannot_make_progress()`, constraint change propagation |
| **P8** | Experience Store | Cross-run structural reuse — decompositions, workflows, recovery sequences, strategy weights |
| **P9** | Reviewer Pass & Output Contract | Three-lens reviewer, adversarial prior, full output contract validation |
| **P10** | Canvas Integration | 10 new harness canvas node types, diagnostic health dashboard, updated framework adapters |
| **P11** | E2E Integration & Testing | End-to-end tests covering all 10 architectural invariants across all four frameworks |

See [plan/full_harness_architecture.html](https://github.com/3IVIS/itsharness/blob/main/plan/full_harness_architecture.html) for the complete architecture reference — pseudo-code, node definitions, layer table, state model, and scope.

---

## Quick start

### 1. Run setup

```bash
./scripts/setup-env.sh
```

Generates secrets, writes `.env`, optionally creates the Python venv and starts the stack. Safe to re-run — existing real values are never overwritten.

### 2. Start the stack

```bash
docker compose up
```

| Service | URL |
|---|---|
| Canvas | http://localhost:3000 |
| Adapter API | http://localhost:8000/health |
| Langfuse | http://localhost:3001 |

Nine services start: canvas, adapter, mastra-runner, postgres, redis, clickhouse, litellm, langfuse-web, langfuse-worker.

> **Startup errors?** See [docs/troubleshooting.md](https://github.com/3IVIS/itsharness/blob/main/docs/troubleshooting.md). The most common causes are a stale Postgres volume (`./scripts/reset-volumes.sh`) or a secret that's wrong length (`bash scripts/check-env.sh`).

**Real-time collaboration** is opt-in — see [docs/collab.md](https://github.com/3IVIS/itsharness/blob/main/docs/collab.md).  
**On-prem / Kubernetes** — see [docs/deployment.md](https://github.com/3IVIS/itsharness/blob/main/docs/deployment.md).

### Without Docker

```bash
./scripts/setup-env.sh
source adapter/.venv/bin/activate
npm install && npm run dev       # canvas → http://localhost:3000
cd adapter && python main.py     # adapter → http://localhost:8000
```

### Tests

```bash
npm test                                          # Vitest — validates all 5 reference flows
pytest adapter/tests/ -v                         # adapter unit + integration suite
pytest adapter/tests/test_maf_adapter.py -v     # MAF adapter suite (742 tests)
```

### Diagnostics

| Script | What it checks |
|---|---|
| `bash scripts/verify_services.sh` | All containers running · healthchecks · HTTP endpoints · Redis / Postgres / Langfuse auth |
| `bash scripts/verify_llm.sh` | Ollama → LiteLLM → adapter LLM path (3 independent layers) |
| `bash scripts/verify_hitl.sh` | HITL pause → resume → done for LangGraph, Mastra, MAF |
| `bash scripts/verify_observability.sh` | Langfuse trace confirmed for all 4 runtimes |
| `bash scripts/verify_prompts.sh` | Langfuse prompt API · adapter HTTP proxy · SDK resolve |

Set `TEST_EMAIL=... TEST_PASSWORD=...` to skip the interactive credentials prompt.

---

## LLM providers

All LLM calls route through **LiteLLM**. Add the relevant key(s) to `.env`:

| Provider | Key | Model name in flow spec |
|---|---|---|
| OpenAI | `OPENAI_API_KEY=sk-...` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY=sk-ant-...` | `claude-sonnet`, `claude-haiku`, `claude-opus` |
| Ollama (local) | none | `mistral`, `qwen3`, `qwen2.5-coder` |

For full setup instructions including Ollama and custom models see [docs/llm-setup.md](https://github.com/3IVIS/itsharness/blob/main/docs/llm-setup.md).

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

## The spec — `@itsharness/flow-spec`

**Current version:** `0.2.0` · **RFC:** closed — field semantics in [`docs/adr/001`](https://github.com/3IVIS/itsharness/blob/main/docs/adr/001-codegen-field-semantics.md)

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
| [01 — RAG Agent](https://github.com/3IVIS/itsharness/blob/main/flows/01-rag-agent-flow.json) | LangGraph | `memory_read` semantic, `transform` fn_ref |
| [02 — Content Moderation + HITL](https://github.com/3IVIS/itsharness/blob/main/flows/02-content-moderation-hitl-flow.json) | Mastra | `llm_call` structured output, `hitl_breakpoint` |
| [03 — Parallel Risk Assessment](https://github.com/3IVIS/itsharness/blob/main/flows/03-parallel-risk-assessment-flow.json) | CrewAI | `parallel_fork/join`, `agent_role` ×3 |
| [04 — Research Crew](https://github.com/3IVIS/itsharness/blob/main/flows/04-research-crew-flow.json) | CrewAI | `context_from` on edges, `tool_approval: "human"` |
| [05 — Debate Agent + A2A](https://github.com/3IVIS/itsharness/blob/main/flows/05-debate-agent-a2a-flow.json) | MS Agent Framework | `agent_debate`, `a2a_config` |
| [06 — Ollama Simple](https://github.com/3IVIS/itsharness/blob/main/flows/06-ollama-simple-flow.json) | All | Single `llm_call`; no external deps — used by `scripts/setup-ollama.sh` |
| [07 — Minimal HITL Test](https://github.com/3IVIS/itsharness/blob/main/flows/07-minimal-hitl-test-flow.json) | LG / MA / MAF | No LLM; always pauses — used by `scripts/verify_hitl.sh` |
| [Plan + Execute](https://github.com/3IVIS/itsharness/blob/main/flows/flow-plan-execute.json) | All | `hitl_breakpoint` ×2, `agent_role`, `llm_call` quality gates |
| [Parallel Research](https://github.com/3IVIS/itsharness/blob/main/flows/flow-parallel-research.json) | All | `parallel_fork/join`, 3 concurrent `agent_role` researchers |
| [LLM Planner (meta-flow)](https://github.com/3IVIS/itsharness/blob/main/flows/flow-llm-planner-meta.json) | All | `agent_role` generates a FlowSpec; `condition` retry loop |
| [Research + Write](https://github.com/3IVIS/itsharness/blob/main/flows/flow-research-write.json) | All | `parallel_fork/join`, `hitl_breakpoint` quality gate, `transform` |

### Adapter coverage

| Runtime | Status | Key notes |
|---|---|---|
| **LangGraph** · Python | ✅ Full | `@observe` trace + child spans · HITL via `interrupt()` |
| **CrewAI** · Python | ✅ Full | `context_from → Task.context` · tier-aware `Crew()` memory |
| **Mastra** · TypeScript | ✅ Full | Node.js sidecar · `suspend()/resume()` HITL |
| **MS Agent Framework** · Python / semantic-kernel 1.x | ✅ Full | `AgentGroupChat` native · HITL via `_HitlPause` · OTel → Langfuse |

---

## Running flows

```bash
# Unified runner — any runtime, HITL-aware
bash scripts/run.sh --runtime langgraph flows/flow-plan-execute.json topic="AI agents"

# Or use per-runtime wrappers (prompt for credentials, stream node events):
bash scripts/run_langgraph.sh flow-plan-execute.json
bash scripts/run_mastra.sh    flow-plan-execute.json
bash scripts/run_maf.sh       flow-plan-execute.json
bash scripts/run_crewai.sh    flow-plan-execute.json   # no API-level HITL
```

See [docs/api.md](https://github.com/3IVIS/itsharness/blob/main/docs/api.md) for the full REST API reference including compile, execute, deploy, and HITL resume endpoints.

---

## The `@itsharness/canvas` package

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

See [`packages/canvas/README.md`](https://github.com/3IVIS/itsharness/blob/main/packages/canvas/README.md) for the full props reference.

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
├── flows/                       ← 11 flows (5 published reference + 6 working), 12 files
│   ├── 01–05-*.json               Published reference flows (see table above)
│   ├── 06-ollama-simple-flow.json
│   ├── 07-minimal-hitl-test-flow.json
│   ├── 04-research-crew-flow-test.json  (test variant of 04)
│   └── flow-{plan-execute,parallel-research,llm-planner-meta,research-write}.json
│
├── plan/                        ← Architecture planning documents
│   ├── full_harness_architecture.html  Complete 22-node / 11-layer architecture reference
│   ├── harness_implementation_plan.html
│   ├── phase_0_plan.html
│   └── phase_1_plan.html
│
├── scripts/                     ← Helper scripts (all run from project root)
│   ├── setup-env.sh               First-time setup — secrets, venv, Docker
│   ├── setup-ollama.sh            Test all 4 runtimes against local Ollama
│   ├── check-env.sh               Validate required secrets in .env
│   ├── reset-volumes.sh           Wipe Postgres / Redis / Clickhouse volumes
│   ├── run.sh                     Unified flow runner — any runtime, HITL-aware
│   ├── run_{langgraph,crewai,mastra,maf}.sh   Per-runtime wrappers (interactive, HITL-aware)
│   ├── verify_{services,llm,hitl,observability,prompts}.sh   Regression verification
│   └── ingest_rag_data.py         Ingest documents into the RAG vector store
│
├── packages/
│   └── canvas/                  ← @itsharness/canvas (published npm)
│
├── src/                         ← Canvas app (React + TypeScript + XYFlow)
│   ├── collab/                    Yjs CRDT real-time collaboration layer
│   ├── spec/                      Canvas schema + validation
│   ├── store/index.ts             Zustand store
│   ├── canvas/nodes/              14 node components
│   └── components/                Sidebar, ConfigPanel, deploy panels, HITL
│
├── adapter/                     ← FastAPI backend
│   ├── langgraph_adapter.py, crewai_adapter.py, mastra_adapter.py, maf_adapter.py
│   ├── sso_auth.py                OIDC + SCIM 2.0
│   ├── migrations/versions/       Alembic migrations 0001–0008
│   └── tests/
│
├── mastra-runner/               ← Node.js sidecar for Mastra execution
│
├── deploy/helm/itsharness/      ← On-prem Helm chart (v0.1.0)
│
├── .github/workflows/
│   ├── ci.yml, eval.yml, deploy.yml
│   └── publish-spec.yml, publish-canvas.yml
│
└── docs/
    ├── architecture.md, api.md, llm-setup.md
    ├── collab.md, deployment.md, troubleshooting.md
    └── adr/001-codegen-field-semantics.md
```

> **`spec/schema.ts` vs `src/spec/schema.ts`** — `spec/schema.ts` is the canonical published schema. When the spec changes, update both and run `scripts/check-schema-sync.mjs`.

---

## Further reading

| Document | Contents |
|---|---|
| [docs/architecture.md](https://github.com/3IVIS/itsharness/blob/main/docs/architecture.md) | System design, service interactions, data flows, key decisions |
| [docs/api.md](https://github.com/3IVIS/itsharness/blob/main/docs/api.md) | Full API reference — all endpoints, auth, error codes |
| [docs/tests-and-scripts.md](https://github.com/3IVIS/itsharness/blob/main/docs/tests-and-scripts.md) | All test suites and helper scripts — what each covers and how to run them |
| [docs/llm-setup.md](https://github.com/3IVIS/itsharness/blob/main/docs/llm-setup.md) | LLM provider setup — OpenAI, Anthropic, Ollama, custom models |
| [docs/collab.md](https://github.com/3IVIS/itsharness/blob/main/docs/collab.md) | Real-time collaboration — setup, Yjs internals, env vars |
| [docs/deployment.md](https://github.com/3IVIS/itsharness/blob/main/docs/deployment.md) | Docker, Helm, SSO/OIDC configuration, full env var reference |
| [docs/troubleshooting.md](https://github.com/3IVIS/itsharness/blob/main/docs/troubleshooting.md) | Common startup errors and fixes |
| [docs/adr/001](https://github.com/3IVIS/itsharness/blob/main/docs/adr/001-codegen-field-semantics.md) | Codegen field semantics: `output_key`, `*_expr`, `context_from`, `memory_write.tier` |
| [plan/full_harness_architecture.html](https://github.com/3IVIS/itsharness/blob/main/plan/full_harness_architecture.html) | Complete architecture — pseudo-code, all 22 nodes, all 11 layers, state model, scope |
| [plan/harness_implementation_plan.html](https://github.com/3IVIS/itsharness/blob/main/plan/harness_implementation_plan.html) | Full 11-phase implementation plan |
| [CONTRIBUTING.md](https://github.com/3IVIS/itsharness/blob/main/CONTRIBUTING.md) | How to contribute — adapters, schema, canvas, migrations |
| [packages/canvas/README.md](https://github.com/3IVIS/itsharness/blob/main/packages/canvas/README.md) | `@itsharness/canvas` usage and props |
| [spec/CHANGELOG.md](https://github.com/3IVIS/itsharness/blob/main/spec/CHANGELOG.md) | Spec version history |

---

## License

Apache 2.0 — see [LICENSE](https://github.com/3IVIS/itsharness/blob/main/LICENSE).
