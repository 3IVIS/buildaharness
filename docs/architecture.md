# Architecture

## Overview

buildaharness is a harness for building AI agent workflows. The core idea is a **neutral intermediate representation** (the FlowSpec) that decouples authoring from execution. The canvas authors specs; adapters compile them; the adapter API executes and observes them.

```
┌─────────────────────────────────────────────────────────────┐
│  Canvas  (React + XYFlow)                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Node graph  │  │  Config      │  │  Sidebar           │  │
│  │  26 types    │  │  panels      │  │  Library / Mkt    │  │
│  │  (14 base +  │  │  + Harness   │  │                   │  │
│  │   12 harness) │  │  Diagnostics │  │                   │  │
│  └──────┬──────┘  └──────────────┘  └───────────────────┘  │
│         │ FlowSpec (JSON, v1.0.0)                            │
└─────────┼───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│  Adapter API  (FastAPI, Python)                             │
│                                                              │
│  /compile ──→ langgraph_adapter.py  → Python/LangGraph      │
│           ──→ crewai_adapter.py     → Python/CrewAI         │
│           ──→ mastra_adapter.py     → TypeScript/Mastra     │
│           ──→ maf_adapter.py        → Python/MAF            │
│                                                              │
│  /run ────→ async job queue  →  node_events SSE stream      │
│  /deploy ─→ REST + MCP + A2A endpoints                      │
│  /eval ───→ Langfuse LLM-as-judge scoring                   │
│                                                              │
│  Harness layer (adapter/harness/)                           │
│  ├── 11-layer reasoning & control system                    │
│  ├── 22-node execution loop                                 │
│  ├── HarnessRunState persisted to Postgres                  │
│  └── Langfuse tracing (10 diagnostic attrs per span)        │
└────────┬────────────────────────────────────────────────────┘
         │
         ├── Postgres (flows, jobs, teams, orgs, deployments, harness state)
         ├── Redis (JWT revocation blocklist, OIDC CSRF state, refresh tokens)
         ├── LiteLLM (LLM proxy — OpenAI + Anthropic + others)
         └── Langfuse (trace + eval storage via ClickHouse + Redis BullMQ)
```

## Services

| Service | Image | Port | Purpose |
|---|---|---|---|
| `canvas` | Dockerfile.canvas | 3000 | React + Vite dev / nginx prod |
| `adapter` | Dockerfile.adapter | 8000 | FastAPI — compile, run, deploy, auth |
| `mastra-runner` | mastra-runner/Dockerfile | 8001 | Node.js sidecar — Mastra execution sandbox |
| `postgres` | postgres:15 | 5432 | Primary DB — flows, jobs, teams, orgs |
| `redis` | redis:7 | 6379 | JWT blocklist (DB 1) + Langfuse BullMQ (DB 0) |
| `clickhouse` | clickhouse/clickhouse-server:24.3 | 8123 | Langfuse trace + analytics storage |
| `litellm` | ghcr.io/berriai/litellm | 4000 | LLM proxy with cost callback to Langfuse |
| `langfuse-web` | langfuse/langfuse:3 | 3001 | Langfuse UI + API |
| `langfuse-worker` | langfuse/langfuse:3 | — | Async trace persistence (BullMQ consumer) |

## Data flows

### Execution flow

```
Canvas → POST /run → job created (Postgres) → adapter dispatches by runtime
       → job_events appended to jobs.events JSONB
       → runPoller polls GET /run/{job_id}
       → canvas receives node_events → live overlay updates
       → OTel spans emitted via @observe → Langfuse OTLP
       → LiteLLM cost callback → Langfuse trace
       → run complete → trace_url in job status → "View trace →" toast
```

### HITL flow

```
hitl_breakpoint node reached → adapter raises _HitlPause exception
→ job status set to "paused" → runPoller detects status change
→ HitlResumePanel shown, amber ring on node
→ user submits resume payload → POST /run/{job_id}/resume
→ job re-queued with resume payload → execution continues from checkpoint
```

### Deploy flow

```
POST /deploy/{flow_id}
→ upserts unified_deployments row (rest_url, mcp_url, a2a_url, shareable_url)
→ if a2a_config.enabled: upserts a2a_deployments row + generates AgentCard
→ REST: POST /flows/{id}/invoke live immediately
→ MCP: GET /.well-known/mcp/{id}.json live immediately
→ A2A: GET /.well-known/agent/{id}.json + POST /a2a/{id}/tasks/send live
```

### Observability stack

```
LangGraph / CrewAI / MAF runners
  → @observe decorator (Langfuse Python SDK v4, OTel transport)
  → OTel spans via contextvars.copy_context().run()
  → OTLP → Langfuse OTLP ingestion endpoint

LiteLLM
  → success_callback / failure_callback → Langfuse
  → every LLM call: model, tokens, cost, latency

Canvas
  → VITE_LANGFUSE_ENABLED → Langfuse JS SDK
  → session events linked to active execution trace

Langfuse web/worker
  → BullMQ consumer → ClickHouse write
  → UI at http://localhost:3001
```

## Security model

**Authentication** — JWTs signed with HS256. Every protected endpoint checks a valid, non-expired token with a `jti` claim. `POST /auth/logout` writes the jti to Redis with TTL = token remaining lifetime. Login always runs bcrypt regardless of whether the email exists (prevents timing-based user enumeration).

**SSO / OIDC** — `GET /auth/sso/login` generates a cryptographically random CSRF state token (Redis, 10-minute TTL) and redirects to the OIDC provider. The callback exchanges the code, provisions the user, and issues a JWT plus a single-use refresh token stored in Redis (consumed atomically via GETDEL on use).

**SCIM 2.0** — `PATCH /scim/v2/Users/{id}` supports RFC 7644 and Okta-style deactivation. Sets `is_active = false` (blocks all logins/token checks) and the `DEACTIVATED` sentinel on `password_hash` so bcrypt never sees an invalid hash.

**`fn_ref` validation** — validated at all three entry points (`/compile`, `/flows`, `/run`) against a strict allowlist before any codegen or `exec()` call. Path traversal, shell metacharacters, and multiple colons are all rejected with a 400.

**Request limits** — body size capped at `MAX_BODY_BYTES` (default 1 MB). Rate limits on all mutating endpoints via slowapi.

**Containers** — both Dockerfiles run as non-root users.

**Response headers** — every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Content-Security-Policy`.

## Real-time collaboration

See [collab.md](./collab.md) for the full Yjs architecture.

At the component level:

```
App.tsx
  └── createCollabDoc(flowId, roomKey)
        ├── Y.Doc — CRDT document
        ├── WebsocketProvider → y-websocket server
        ├── IndexeddbPersistence → local offline cache
        └── bindYjsToStore() — bidirectional sync with Zustand

Canvas.tsx
  ├── CollabStatus  — connection indicator (top-right)
  └── CollabCursors — peer cursor overlays (absolute-positioned over ReactFlow)
```

## The `@buildaharness/canvas` package

The embeddable package uses a **context-scoped store** rather than a module-level singleton, making it safe to mount multiple `<BuildAHarnessCanvas>` instances on one page. The pattern:

```
BuildAHarnessCanvas
  └── CanvasStoreProvider (React context)
        └── createStore() — fresh Zustand store per mount
              └── ReactFlow + all nodes/edges/components
```

Host apps access the store via `useCanvasStore()` which reads from the nearest `CanvasStoreProvider` in the tree. This means config panels rendered *inside* the canvas component automatically bind to the correct instance.

## Harness layer

The harness layer (`adapter/harness/`) is the reasoning and control architecture that sits above the execution nodes. It makes agents *reliable*, not merely capable. All 12 phases are complete.

### 11-layer architecture

The 11 fundamental layers are the core reasoning and control design. Five additional supporting modules were introduced in later phases and are listed separately below.

| Layer | Module(s) | Responsibility |
|---|---|---|
| World Model | `world_model.py`, `world_model_ops.py`, `staleness.py` | Typed beliefs and observations with `generation_id` staleness tracking; `integrate_evidence()` enforces observation/conclusion separation |
| Evidence & Reasoning | `evidence.py`, `tool_reliability.py`, `tool_manifest.py` | Evidence store, reliability envelopes that cap conclusion reliability per tool type, tool availability manifest |
| Hypothesis | `hypothesis.py` | 4-source generation (symptom, counterfactual, failure library, analogy), Shannon entropy diversity enforcement (threshold 0.7), K-retention elimination |
| Contradiction Detection | `contradiction.py`, `belief_graph.py` | Pairwise, temporal, abstraction-level contradiction detection; `SYSTEM_BREAKING` contradictions enter `world_model.contradictions[]` and are picked up by Tier 1 on the next control state resolution |
| Diagnostics | `diagnostics.py` | 10 normalised `[0,1]` sub-dimensions feeding the 5-tier control state resolver |
| Control State | `control_state.py` | 5-tier `resolve_control_state()`: Tier 1 SYSTEM_BREAKING → Tier 2 deadlock → Tier 3 block mask → Tier 4 weighted → Tier 5 NORMAL |
| Planning | `task_graph.py`, `parallel_merge.py` | 6-state task graph, conflict probability cache, parallel branch merge with contradiction detection at join |
| Execution | `execution.py`, `voi.py`, `risk.py`, `review_gate.py` | VOI-gated evidence gathering, risk estimation, reversibility strategies, pre-execution review gate |
| Verification | `verification.py` | 9-layer verification (including adversarial pass for HIGH risk actions) |
| Recovery | `recovery.py`, `replanning.py`, `progress.py`, `failure_modes.py`, `memory.py` | Named strategies (DIRECT_EDIT → TRACE_EXEC → ...), stall detection, global/local replanning, context compression with dependency-risk tracking |
| Reviewer Pass | `reviewer.py` | 3-lens review (consistency, adversarial, abstraction fit); adversarial prior discarded after use (INV-09) |

**Supporting modules (added in later phases)**

| Module | Module(s) | Responsibility |
|---|---|---|
| Caller State | `caller_state.py` | `CallerState` — mutable constraints, clarification history, success criteria, constraint-change propagation |
| Caller Updates & Escalation | `external_updates.py`, `constraint_propagation.py`, `escalation.py` | PostgreSQL NOTIFY channel for live constraint changes, `surface_blocker` escalation to HITL |
| Experience Store | `experience_store.py` | Cross-run learning via softmax strategy weights; warm start from prior decompositions; no-op when absent |
| Process Concepts | `process_concept.py`, `process_registry.py`, `process_tools.py` | Static task graph templates that seed planning without locking it; agent-callable `list_processes()`, `load_process()`, `get_current_step()`, `complete_step()` |
| Output Contract | `output_contract.py` | 4-check validation: format requirements, required sections, interface constraints, caller-specific constraints |

### Architectural invariants

Ten invariants are permanently enforced by `adapter/tests/test_harness_invariants.py`:

- **INV-01** Observations and beliefs are separate structures; HIGH-reliability tool output never auto-promotes to a belief without an explicit `derived_from[]` chain.
- **INV-02** Every diagnostic sub-dimension entering `resolve_control_state()` is normalised `[0,1]`.
- **INV-03** `world_model.generation_id` increments exactly twice per loop iteration (pre- and post-execution).
- **INV-04** Mutual deadlock in `block_mask` always escalates to `HUMAN_REQUIRED`, never attempts autonomous recovery.
- **INV-05** `SYSTEM_BREAKING` contradictions never halt inline; they enter `contradictions[]` and are read by Tier 1 on the next resolve call.
- **INV-06** `select_best_action()` reads `control_state` exclusively for control decisions.
- **INV-07** `dep_class_gap_annotation` is advisory only — never a numeric input to any resolver tier.
- **INV-08** `failure_mode_library` contributes to Tier 4 and hypothesis generation only; it cannot veto or block.
- **INV-09** `adversarial_prior` is discarded after `adversarial_lens()` completes and never persists.
- **INV-10** All code paths that use `experience_store` guard with `experience_store.available`; the agent runs identically without it.

### Harness canvas nodes (12 types)

Three harness node types were added in Phase 1 alongside the core reasoning layers:

| Node type | Backend compiler |
|---|---|
| `gather_evidence` | `compile_gather_evidence` |
| `apply_tool_reliability` | `compile_apply_tool_reliability` |
| `update_world_model` | `compile_update_world_model` |

Nine additional harness node types were added in Phase 10 as first-class canvas nodes with config classes:

| Node type | Config class | Backend compiler |
|---|---|---|
| `world_model_node` | `WorldModelNodeConfig` | `compile_world_model_node` |
| `hypothesis_set_node` | `HypothesisSetNodeConfig` | `compile_hypothesis_set_node` |
| `control_state_node` | `ControlStateNodeConfig` | `compile_control_state_node` |
| `task_graph_node` | `TaskGraphNodeConfig` | `compile_task_graph_node` |
| `verification_gate_node` | `VerificationGateNodeConfig` | `compile_verification_gate_node` |
| `recovery_node` | `RecoveryNodeConfig` | `compile_recovery_node` |
| `evidence_store_node` | `EvidenceStoreNodeConfig` | `compile_evidence_store_node` |
| `experience_store_node` | `ExperienceStoreNodeConfig` | `compile_experience_store_node` |
| `reviewer_pass_node` | `ReviewerPassNodeConfig` | `compile_reviewer_pass_node` |

`process_concept` is registered in `HARNESS_NODE_COMPILERS` as a compiler-only entry (no canvas schema node type); it is invoked by the harness loop directly rather than authored as a canvas node.

The `DiagnosticsPanel` (`src/components/panels/DiagnosticsPanel.tsx`) renders all 10 sub-dimensions as `[0,1]` bar charts during live runs.

### Process concepts

Process concepts (`concepts/`) are JSON templates that seed the task graph at harness init without locking it. Built-in concepts: `debug_test_failure`, `implement_feature`, `code_review`, `refactor_module`. Register custom concepts by pointing the adapter at a directory via `DEFAULT_REGISTRY.scan_directory()`.

```
GET /run/concepts          List all registered concepts
harness_meta.process_concept_id  Name the concept in the FlowSpec
```

### Harness state persistence

`HarnessRunState` is persisted to Postgres via migrations `0009`–`0011`. The adapter API exposes:

```
GET /runs/{id}/harness-state    Read current HarnessRunState
PUT /runs/{id}/harness-state    Write updated HarnessRunState
POST /{job_id}/escalation/respond   Respond to a surface_blocker escalation
```

### Harness Langfuse tracing

`adapter/harness/langfuse_tracing.py` emits per-iteration spans with 10 diagnostic attributes, strategy change events, and escalation events. All tracing is no-op when Langfuse is absent (`TESTING=true`).

---

## npm packages

In addition to the server-side adapter, buildaharness ships five npm packages:

| Package | Purpose |
|---|---|
| `@buildaharness/canvas` | Embeddable React canvas component (context-scoped store) |
| `@buildaharness/harness` | TypeScript types and node implementations for the harness state structures |
| `@buildaharness/runtime` | Framework-agnostic TypeScript runtime — executes FlowSpec flows without a server |
| `@buildaharness/react` | React hook (`useHarness`) for embedding runtime-driven flows in React apps |
| `@buildaharness/proxy` | LLM proxy that keeps API keys server-side — ships as a Cloudflare Worker or Docker service |

### `@buildaharness/harness`

TypeScript mirror of the Python harness state layer. Provides typed interfaces for `WorldModel`, `HypothesisSet`, `ControlState`, `TaskGraph`, `EvidenceStore`, `ExperienceStore`, `CallerState`, `OutputContract`, and all associated sub-structures. Also includes the full set of harness node implementations (e.g. `gather-evidence`, `detect-contradictions`, `resolve-control-state`, `execute`, `verify`, `reviewer-pass`).

### `@buildaharness/runtime`

Executes FlowSpec flows client-side or in a Node.js process without needing the adapter server. All 14 base node types have executors. Useful for testing flows in CI without a running stack, or for embedding flows in desktop/Electron apps.

### `@buildaharness/react`

`useHarness(flowSpec, input)` hook that wraps `@buildaharness/runtime`. Returns `{ status, result, nodeEvents, resume }`.

### `@buildaharness/proxy`

Thin Hono server that issues short-lived JWTs and forwards LLM requests to Anthropic or OpenAI, keeping API keys off the client. Deploys to Cloudflare Workers or Docker. See `packages/proxy/README.md` and `docs/env-vars.md`.

---

## Key design decisions

**Neutral spec IR.** The canvas emits a neutral JSON spec. Adapters translate it. Swapping runtimes means updating one adapter file. Canvas, versioning, RBAC, eval, and collab are decoupled from runtime choice.

**TypeScript on XYFlow, not Python on LangFlow.** LangFlow wires components; a harness needs to author state machines. XYFlow gives the right canvas model with a single-language stack and a clean embeddable-package path.

**Langfuse (MIT, self-hosted) over LangSmith.** LangSmith is proprietary SaaS. Langfuse is MIT, self-hostable, OTel-compatible. The Python SDK v4 uses OTel as its native transport, making per-node child spans straightforward via `contextvars.copy_context().run()`.

**ADR-001 as the spec-to-adapter contract.** Four field semantics were left open during spec design. Closing them via ADR means zero breaking changes and a permanent reference for future adapter authors.

## Further reading

- [flowspec.md](./flowspec.md) — complete FlowSpec v1.0.0 field-by-field reference for all 27 node types
- [env-vars.md](./env-vars.md) — all environment variables across all services
- [qdrant.md](./qdrant.md) — Qdrant vector store setup, seeding, and production deployment

**`fn_ref` allowlist over sandboxing.** Generated code is exec'd directly. Full sandboxing is complex and escape-prone. Validating `fn_ref` values at every entry point before any codegen or exec() call is simpler, auditable, and effective.
