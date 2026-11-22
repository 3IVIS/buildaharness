# Architecture

## Overview

buildaharness is a harness for building AI agent workflows. The core idea is a **neutral intermediate representation** (the FlowSpec) that decouples authoring from execution. The canvas authors specs; adapters compile them; the adapter API executes and observes them.

The repository holds two products on one harness:

- **The workflow platform** — canvas, FlowSpec, the four runtime adapters and the adapter API (everything from "Services" to "Harness layer" below).
- **Aielia** — an everyday chat assistant (`@buildaharness/aielia`) that runs the TypeScript harness client-side on every turn. The CLI, the browser app and the Tauri desktop app are three surfaces over one shared implementation; see [Aielia (the assistant)](#aielia-the-assistant).

A harness is a **governance and reliability control plane** around an autonomous agent: the agent has intelligence, the harness has authority. The agent proposes; the harness decides what's allowed to happen next; evidence decides whether the result is accepted. The 11 layers below (plus the Trajectory Supervisor and the 6 supporting modules that grew up around them) are not a loose collection — every one of them is an implementation of exactly one of 5 primitives:

| Primitive | Source of truth for |
|---|---|
| **State** | What is currently the case — beliefs, plan structure, version identities, rollback points |
| **Evidence** | Why we believe what we believe — independent observations, tool reliability, contradictions |
| **Policy** | What is allowed, and in what mode — authorization, execution mode, response contract, reviewer verdict |
| **Effect** | Doing something with a consequence — tool invocation, file mutation, the idempotency machinery around it |
| **Recovery** | Responding to failure — classification, strategy selection, bounded retry, escalation |

Full mapping (every layer and persistent state object → primitive), the "who wins" authority rulings for cross-primitive conflicts, and the structural seams the mapping surfaced are recorded in ADR-003 (harness consolidation) — which sits beside ADR-002 (the Harness Semantic Contract) rather than over it. The ADRs are maintained outside this repo; they are referenced here and in code by their `ADR-NNN` identifier. The ones cited on this page: ADR-001 (codegen field semantics), ADR-002 (Harness Semantic Contract), ADR-003 (harness consolidation), ADR-004 (shared semantic core), ADR-005 (Trajectory Supervisor), ADR-006 (generic ask-question mechanism), ADR-007 (lexical decisions) and ADR-008 (agent memory write path).

```
┌─────────────────────────────────────────────────────────────┐
│  Canvas  (React + XYFlow)                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Node graph  │  │  Config      │  │  Sidebar           │  │
│  │  27 types    │  │  panels      │  │  Library / Mkt    │  │
│  │  (14 core +  │  │  + Harness   │  │                   │  │
│  │   13 harness) │  │  Diagnostics │  │                   │  │
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
│  /run ────→ async job queue  →  node_events (polled)      │
│  /deploy ─→ REST + MCP + A2A endpoints                      │
│  /eval ───→ Langfuse LLM-as-judge scoring                   │
│                                                              │
│  Harness layer (adapter/harness/)                           │
│  ├── 11-layer reasoning & control system                    │
│  ├── per-iteration loop (runtime.py HarnessRuntime)         │
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
| `postgres` | postgres:16-alpine | 5432 | Primary DB — flows, jobs, teams, orgs, harness state |
| `redis` | redis:7-alpine | 6379 | JWT blocklist (DB 1) + Langfuse BullMQ (DB 0) |
| `clickhouse` | clickhouse/clickhouse-server:24.3 | 8123 | Langfuse trace + analytics storage |
| `litellm` | ghcr.io/berriai/litellm | 4000 | LLM proxy with cost callback to Langfuse |
| `qdrant` | qdrant/qdrant:v1.13.0 | 6333 | Vector store (coaching KB / RAG) |
| `minio` | minio/minio | 9002 (S3 API), 9003 (console) | S3-compatible object storage for Langfuse; `minio-init` is a one-shot bucket-setup job |
| `langfuse` | langfuse/langfuse:3 | 3001 | Langfuse UI + API |
| `langfuse-worker` | langfuse/langfuse-worker:3 | — | Async trace persistence (BullMQ consumer) |

## Data flows

### Execution flow

```
Canvas → POST /run → job created (Postgres) → adapter dispatches by runtime
       → node events appended to the job's node_events JSONB column
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

**Capability manifest** — `adapter/capability_manifest.py` grades each adapter's real support (`full`/`partial`/`missing`) for five runtime capabilities (`durable_checkpoint`, `human_interrupt`, `parallel_join`, `transactional_tool`, `streaming_tokens`), determined by reading each adapter's actual codegen rather than assumed. `/compile` infers what a FlowSpec requires from its own schema (checkpoint config, streaming mode, `hitl_breakpoint`/`parallel_join` nodes) and fails fast with a 422 if a required capability is `missing` on the target runtime; a `partial` capability compiles with a warning in `CompileResponse.warnings` instead of failing silently.

**Request limits** — body size capped at `MAX_BODY_BYTES` (default 1 MB). Per-route rate limits via slowapi on the auth, run, compile, flows, deploy, A2A, org/team, eval and marketplace endpoints (see [api.md](api.md#rate-limits)).

**Containers** — the canvas, adapter and mastra-runner Dockerfiles all run as non-root users.

**Response headers** — every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-XSS-Protection: 0`; every path except `/auth*` and `/run*` also gets a restrictive `Content-Security-Policy` (`default-src 'none'; frame-ancestors 'none'`).

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

The harness layer (`adapter/harness/`) is the reasoning and control architecture that sits above the execution nodes. It makes agents *reliable*, not merely capable. 

### Shared semantic core (Python ↔ TypeScript)

The Python harness (`adapter/harness/`) and the TypeScript harness (`@buildaharness/harness`) used to duplicate their pure-data constants (thresholds, the recovery-dependency table, `LAYER_TIER`) by hand, checked for drift by `scripts/check-harness-constants-sync.mjs`. That script is now retired: `spec/harness-core.json` is the single source, `spec/gen-harness-core.mjs` generates `adapter/harness/_core_generated.py` and `packages/harness/src/_core-generated.ts` from it (also `RECOVERY_CLASSIFICATION_TABLE`, added in Phase C2 — see the Recovery layer below), and both languages' `control_state.py` / `resolve-control-state.ts` import from the generated module instead of declaring the constants themselves — CI fails (`node spec/gen-harness-core.mjs --check`) if either generated file is stale. The ~150-line resolver *algorithm* stays hand-mirrored per language rather than generated (the conformance run showed the two implementations were already byte-identical, so generating the algorithm would solve a problem that doesn't exist); the `scripts/harness-conformance/` fixture suite is the named equivalence contract instead, run against both interpreters on every PR — 53 fixtures for the resolver (`compare.mjs`, INV-13, backed by committed goldens), plus a second pair for `verify()` (`compare-verify.mjs`, 25 fixtures, layer-status projection) whose `output_contract_partial` divergence between the two runtimes is now tracked rather than silent. The suite has since grown beyond the resolver and `verify()`: further fixture sets cover the node implementations (107), the runtime and checkpoints (69), the supervisor (20), the ask-question mechanism (49) and the agent-memory twin (40), each with its own `compare-*.mjs` and a `known-discrepancies*.json` file where the two sides are known to differ. See ADR-004 (shared semantic core) for the options considered and why.

### 11-layer architecture

The 11 fundamental layers are the core reasoning and control design; the Trajectory Supervisor (last row) was added on top of them as a stall-edge meta-controller. Six supporting modules were introduced in later phases and are listed separately below. The Python harness is the reference for the adapter API; the TypeScript harness (`@buildaharness/harness`) is what Aielia runs, and the two are held equivalent by the conformance suite (see "Shared semantic core").

| Layer | Module(s) | Responsibility |
|---|---|---|
| World Model | `world_model.py`, `world_model_ops.py`, `staleness.py` | Typed beliefs and observations with `generation_id` staleness tracking; `integrate_evidence()` enforces observation/conclusion separation |
| Evidence & Reasoning | `evidence.py`, `tool_reliability.py`, `tool_manifest.py` | Evidence store, reliability envelopes that cap conclusion reliability per tool type, tool availability manifest |
| Hypothesis | `hypothesis.py` | 4-source generation (symptom, counterfactual, failure library, analogy), Shannon entropy diversity enforcement (threshold 0.7), K-retention elimination |
| Contradiction Detection | `contradiction.py`, `belief_graph.py` | Pairwise, set-level, temporal and abstraction-level contradiction detection (`detect_contradictions()` / `detectContradictions` skips a conflict already recorded in the world model, so an iteration never re-records or re-decays it); `SYSTEM_BREAKING` contradictions enter `world_model.contradictions[]` and are picked up by Tier 1 on the next control state resolution |
| Diagnostics | `diagnostics.py` | 10 normalised `[0,1]` sub-dimensions feeding the 5-tier control state resolver; a parallel `Diagnostics.provenance` map (`DimensionProvenance` = `{source, calibrated, evidence_ids}` per sub-dimension) records where each value came from (INV-11 — defaults to `deterministic` for all ten today, with a `notes[]` annotation when a block is driven by an uncalibrated model-derived value; the resolver fills the default for any un-stamped dimension before reading it) |
| Control State | `control_state.py` | 5-tier `resolve_control_state()`: Tier 1 SYSTEM_BREAKING → Tier 2 deadlock → Tier 3 block mask → Tier 4 weighted → Tier 5 NORMAL |
| Planning | `task_graph.py`, `parallel_merge.py` | 6-state task graph, conflict probability cache, parallel branch merge with contradiction detection at join; every status transition writes through the single `apply_task_outcome(task_graph, task_id, outcome)` path (TS: `applyTaskOutcome`, `packages/harness/src/nodes/apply-task-outcome.ts`) rather than direct `TaskGraph` mutation — `select_best_action()` (Policy) now lives in its own `policy.py`, separate from the State primitive (INV-17) |
| Execution | `execution.py`, `voi.py`, `risk.py`, `review_gate.py` | VOI-gated evidence gathering, risk estimation, reversibility strategies, pre-execution review gate |
| Verification | `verification.py` | 9-layer verification, each classified `mechanical`/`environmental`/`model` (`LAYER_TIER`); `syntax`/`unit` are real subprocess-backed checks via the execution boundary, `consistency`, `evidence_sufficiency` and `output_contract_partial` are real state inspection, the remaining four (`integration`, `requirements`, `assumptions`, `goal_correctness`) are honestly `SKIPPED` (never a fake `PASS`; `requirements`/`assumptions` can only `FAIL` when criteria exist but no result was produced) pending infrastructure that doesn't exist yet; adversarial pass for HIGH risk actions; `VerificationResult.critical_failure_tiers` (TS: `verify.ts`) names which `LAYER_TIER`s contributed a FAIL — a dataclass `__post_init__` (TS: `assertCriticalFailureTiersConsistent()`) enforces it's non-empty iff `has_critical_failure` is true |
| Recovery | `recovery.py`, `replanning.py`, `progress.py`, `failure_modes.py`, `memory.py` | Named strategies (DIRECT_EDIT → TRACE_EXEC → ...), stall detection, global/local replanning, context compression with dependency-risk tracking; a hard multi-dimensional `RecoveryBudget` (tool calls, cost, time, plan revisions) is checked before every strategy switch, additive to the existing `STRATEGY_ORDER` bound — exhaustion on any single dimension escalates rather than continuing; `classify_recovery()`/`RecoveryPolicy` (TS: `classifyRecovery()`, `packages/harness/src/recovery-policy.ts`) is a pure lookup over a 12-row failure-class → policy table generated from `spec/harness-core.json`, additive and not yet wired into strategy selection (an unclassified failure still falls through to `STRATEGY_ORDER` + softmax) |
| Reviewer Pass | `reviewer.py` | 3-lens review (implementer, reviewer, adversarial); adversarial prior discarded after use (INV-09); TS reopens a COMPLETE task only when a reviewer finding names its whole id (`t1` is not reopened by a mention of `t10`; Python's `reviewer.py` still substring-matches, see `HARNESS_PY_VS_TS_MISMATCHES.md`); each pass's highest-severity finding (≥ MEDIUM) becomes a one-shot `ReviewerVerdict` (TS: `reviewer-pass.ts`) that the *next* `resolve_control_state()` call consumes and clears — it can force `execution_mode` to at least `CAUTIOUS` but never sets `permission` itself (INV-18) |
| Trajectory Supervisor | `supervisor.py`, `trajectory_digest.py`, `investigation.py` | Stall-edge-only meta-controller: consulted when progress stalls, returns a one-shot directive; it never touches the resolver or world model directly. Read-only investigations (depth 1, at most `INVESTIGATION_CAP_K` = 3 per run; TS counts every merged investigation, even a repeated question). Off by default in the library, **on by default in Aielia** (`HARNESS_TRAJECTORY_SUPERVISOR`; `=0` disables it); see ADR-005 |

**Supporting modules (added in later phases)**

| Module | Module(s) | Responsibility |
|---|---|---|
| Caller State | `caller_state.py` | `CallerState` — mutable constraints, clarification history, success criteria, constraint-change propagation |
| Caller Updates & Escalation | `external_updates.py`, `constraint_propagation.py`, `escalation.py` | PostgreSQL NOTIFY channel for live constraint changes, `surface_blocker` escalation to HITL |
| Experience Store | `experience_store.py` | Cross-run learning via softmax strategy weights; warm start from prior decompositions; no-op when absent; every write lands `promoted=false` (migration `0012`) and every read (including `warm_start()`) only sees `promoted=true` rows — nothing learned is live until an explicit `promote_entries()`/`promote_strategy_weights()` call, never auto-invoked |
| Process Concepts | `process_concept.py`, `process_registry.py`, `process_tools.py` | Static task graph templates that seed planning without locking it; agent-callable `list_processes()`, `load_process()`, `get_current_step()`, `complete_step()` |
| Output Contract | `output_contract.py` | `output_validation()` / `validate_output_contract()`: format, required sections, interface constraints, validation rules and caller-specific constraints |
| Runtime driver | `runtime.py`, `checkpoint.py` | `HarnessRuntime` — the Python twin of TS `driveMainLoop` (`loop.py`'s `run_one_iteration` is a legacy skeleton kept for tests), with TS-compatible checkpoints that either runtime can resume |

### Architectural invariants

`adapter/tests/test_harness_invariants.py` permanently enforces INV-01 through INV-10 (below), plus black-box tests for INV-11, the plan-load/export invariants, the supervisor invariants INV-20 to INV-25 (one-shot directive, resolver untouched, ignored when not stalled, no write/shell/email tools, depth capped at 1, bounded budget) and the memory-tier invariant INV-16:

- **INV-01** Observations and beliefs are separate structures; HIGH-reliability tool output never auto-promotes to a belief without an explicit `derived_from[]` chain.
- **INV-02** Every diagnostic sub-dimension entering `resolve_control_state()` is normalised `[0,1]`.
- **INV-03** `world_model.generation_id` is monotonic (never decreases within a run), and any version-pinned object (`PlanVersion`/`ExecutionVersion`/`VerificationVersion`/`ControlState`) is judged stale by `is_stale()` if and only if the world model's current version has advanced past the version it was pinned to — replaces the earlier "increments exactly twice per loop iteration" wording, which was a proxy tied to one implementation's lifecycle rather than the property that actually matters (see ADR-002, the Harness Semantic Contract, Decision 3).
- **INV-04** Mutual deadlock in `block_mask` always escalates to `HUMAN_REQUIRED`, never attempts autonomous recovery.
- **INV-05** `SYSTEM_BREAKING` contradictions never halt inline; they enter `contradictions[]` and are read by Tier 1 on the next resolve call.
- **INV-06** `select_best_action()` reads `control_state` exclusively for control decisions.
- **INV-07** `dep_class_gap_annotation` is advisory only — never a numeric input to any resolver tier.
- **INV-08** `failure_mode_library` contributes to Tier 4 and hypothesis generation only; it cannot veto or block.
- **INV-09** `adversarial_prior` is discarded after `adversarial_lens()` completes and never persists.
- **INV-10** All code paths that use `experience_store` guard with `experience_store.available`; the agent runs identically without it.

Eight further invariants (INV-11 through INV-18) were added by the harness-consolidation plan (ADR-003), each enforced in its own phase's test file (`test_harness_c2.py`/`nodes-c2.test.ts`, `test_harness_h.py`/`nodes-h.test.ts`, `test_harness_i.py`/`nodes-i.test.ts`, `turn-policy.test.ts`, `memory-tiers.test.ts`, `harness-runtime-suspend.test.ts`, plus the `scripts/harness-conformance/` suite) rather than `test_harness_invariants.py` — though INV-11 also carries two black-box tests in `test_harness_invariants.py` itself. All of INV-11 through INV-18 have shipped. INV-19 and later are listed after INV-18 below.

- **INV-11** (`Diagnostics.provenance`) No un-provenanced diagnostic sub-dimension reaches `resolve_control_state()` — every dimension carries a `DimensionProvenance` (`{source, calibrated, evidence_ids}`). All ten default to the `deterministic` source today; a resolver block driven by an uncalibrated model-derived value gets a `notes[]` annotation rather than silently counting as calibrated signal.
- **INV-12** `VerificationResult.has_critical_failure` is true if and only if `critical_failure_tiers` is non-empty — enforced structurally by `verification.py`'s `__post_init__` (TS: `assertCriticalFailureTiersConsistent()`), not by a separate test alone.
- **INV-13** The Python and TypeScript control-state resolvers must agree on every `scripts/harness-conformance/` fixture — the equivalence is itself a named invariant (the 53-fixture suite is the contract, not a sample). `scripts/harness-conformance/compare.mjs` runs both interpreters against each other on every PR; the byte-identical assertion is also promoted into the per-language suites against committed goldens (`test_harness_conformance_gate.py`, `conformance-gate.test.ts`), so a one-side drift fails a plain `pytest` / `vitest` run too.
- **INV-14** (`packages/aielia`) A consequential turn decision (approval requirement, plan abandonment) can never be set by the classifier's LLM output alone — `evaluateTurnPolicy()`/`evaluateAbandonPolicy()` (`turn-policy.ts`) always recompute it from structural signals (`riskLevel`, `isBulkReminderRequest`, `hasActivePlan`), the same shape `tool-policy.ts`'s `evaluateToolPolicy()` already used for `riskHint`.
- **INV-15** No node ever calls `execute()` without an `action_gate` decision recorded in the same iteration — including a resumed `'continuation'` (Phase D1's "not done" signal), which now pushes `'action_gate_replay_continuation'` onto `nodeExecutionOrder` instead of nothing.
- **INV-16** (`packages/aielia`) No Experience-tier (`procedural`) or Commitment-tier (`commitment`) entry can be read as a Knowledge belief — `TIER_RULES.procedural`/`TIER_RULES.commitment` have an empty `allowedSources`, so `tierForFact()` can structurally never route a `UserFact` into either tier.
- **INV-17** Every `Task.status` transition goes through the single `apply_task_outcome()`/`applyTaskOutcome()` write path — a grep gate in both test files fails if any other production module calls `TaskGraph.update_task_status()`/`.setStatus()` directly.
- **INV-18** A pending `ReviewerVerdict` of severity ≥ MEDIUM at resolve time yields `execution_mode` of at least `CAUTIOUS` and never changes `permission` on its own; the verdict is consumed and cleared by that same resolve call (one-shot).

**Later invariants (INV-19 to INV-43)** belong to the TypeScript side and Aielia's features. Each is enforced by its own feature's tests, not by `test_harness_invariants.py`:

- **INV-19** `ASSISTANT_ONE_LOOP=disabled` is byte-for-byte identical to the pre-rewire behaviour.
- **INV-20 to INV-25** (Trajectory Supervisor) — one-shot directive; no mutation of `control_state`/diagnostics/beliefs/hypotheses; the model call fires only on the stall edge; investigations are read-only, depth 1, and run on their own bounded `Budget` (exhaustion degrades, never hangs).
- **INV-26 to INV-29, INV-34, INV-37** (ask-question, ADR-006) — a `SurfaceBlocker` without `questions` serializes exactly as before; resolving a batch is one client round trip; an unanswered required question cannot be submitted, and the server rejects it too (fail-closed); a global OFF can never be overridden to ON by a narrower scope (the effective mode is the most restrictive of global, session and call site); a batch holds at most 4 questions of 2–4 options each, and a caller with more candidates batches and defers rather than dropping or truncating.
- **INV-30 to INV-33, INV-35, INV-36** (plan mode) — while plan mode is drafting, no tool runs except the drafting call and one nested question; a plan reaches `active` only through `awaiting_approval` and an explicit approval; `executingOnPlan` clears only on completion or an explicit abort; the file snapshot and the in-memory `PlanRecord` are saved together; the lightweight plan sketch never creates or mutates a `PlanRecord` and holds only `read_file`/`list_directory`; an action is auto-applied under "trust this approved plan" only while the specific approved task that listed it is the one running.
- **INV-38 to INV-43** (goal threads) — at most one `GoalThread` is `ACTIVE`; the Scheduler is the only writer of the active pointer; a thread still being drafted is never selectable; classifier uncertainty defaults to "same goal, new task, deferred" (never a silent abandon or drop); a paused thread keeps its partial state; with `goalGraphMode`/`goalGraphSuggestMode` off, behaviour is byte-identical to before.

### Harness canvas nodes (13 types)

The 13 harness node types in `HARNESS_NODE_COMPILERS` (`adapter/harness/node_compilers.py`) match the `HarnessNode` union in `spec/schema.ts`. Three were added in Phase 1 alongside the core reasoning layers:

| Node type | Backend compiler |
|---|---|
| `gather_evidence` | `compile_gather_evidence` |
| `apply_tool_reliability` | `compile_apply_tool_reliability` |
| `update_world_model` | `compile_update_world_model` |

Nine more were added in Phase 10 as first-class canvas nodes with config classes:

| Node type | Config class | Backend compiler |
|---|---|---|
| `world_model` | `WorldModelNodeConfig` | `compile_world_model_node` |
| `hypothesis_set` | `HypothesisSetNodeConfig` | `compile_hypothesis_set_node` |
| `control_state` | `ControlStateNodeConfig` | `compile_control_state_node` |
| `task_graph_node` | `TaskGraphNodeConfig` | `compile_task_graph_node` |
| `verification_gate` | `VerificationGateNodeConfig` | `compile_verification_gate_node` |
| `recovery_node` | `RecoveryNodeConfig` | `compile_recovery_node` |
| `evidence_store_node` | `EvidenceStoreNodeConfig` | `compile_evidence_store_node` |
| `experience_store_node` | `ExperienceStoreNodeConfig` | `compile_experience_store_node` |
| `reviewer_pass` | `ReviewerPassNodeConfig` | `compile_reviewer_pass_node` |

`process_concept` is the thirteenth: a schema node type (`ProcessConceptNode`, `harness_config.concept_id` required) with its own compiler, `compile_process_concept_node`.

The `DiagnosticsPanel` (`src/components/panels/DiagnosticsPanel.tsx`) renders all 10 sub-dimensions as `[0,1]` bar charts during live runs.

### Canvas node taxonomy and Intent mode

The 13 harness node types are grouped into five categories for canvas display — `HARNESS_NODE_CATEGORY`/`HARNESS_CATEGORY_HEX`/`HARNESS_CATEGORY_LABEL` in `src/canvas/nodes/BaseNode.tsx`, one hue per category:

| Category | Node types |
|---|---|
| OBSERVATION | `gather_evidence`, `apply_tool_reliability` |
| STATE | `world_model`, `hypothesis_set`, `update_world_model`, `evidence_store_node`, `experience_store_node` |
| POLICY | `control_state`, `reviewer_pass` |
| CONTROL_FLOW | `task_graph_node`, `verification_gate`, `process_concept` |
| EFFECT | `recovery_node` |

`src/components/Sidebar.tsx`'s palette groups nodes by these categories (Observation → State → Policy → Control Flow → Effect) instead of one flat "Harness" bucket — UI-side grouping only, no `spec/schema.ts` change.

The sidebar also has an Expert/Intent mode toggle. Expert mode is the full node palette (unchanged). Intent mode swaps it for a small set of high-level templates (`src/spec/intentTemplates.ts` — e.g. "Research → verify sources → draft → human approval → publish") that click-to-insert as a connected chain of real canvas nodes via the `expandIntentTemplate` store action (`src/store/index.ts`); each template step is a `process_concept` node with its `concept_id` set, except steps naming a concrete node type directly (`hitl_breakpoint` for "human approval", `reviewer_pass` for "review"). Templates are click-to-insert at a fixed canvas origin, not drag-and-drop.

### Process concepts

Process concepts (`concepts/`) are JSON templates that seed the task graph at harness init without locking it. Built-in concepts: `debug_test_failure`, `implement_feature`, `code_review`, `refactor_module`. Register custom concepts by pointing the adapter at a directory via `DEFAULT_REGISTRY.scan_directory()`.

```
GET /run/concepts          List all registered concepts (see api.md)
harness_meta.process_concept_id  Name the concept in the FlowSpec
```

### Harness state persistence

`HarnessRunState` is persisted to Postgres (migrations `0009` and `0010`; `0011`/`0012` add the experience store and its promotion flag; `0013` adds the agent-memory tables, see "Agent memory"). The adapter API exposes:

```
GET  /run/{job_id}/harness-state         Read current HarnessRunState
PUT  /run/{job_id}/harness-state         Merge-write HarnessRunState
POST /run/{job_id}/escalation/respond    Respond to a surface_blocker escalation
```

### Harness Langfuse tracing

`adapter/harness/langfuse_tracing.py` emits per-iteration spans with 10 diagnostic attributes, strategy change events, and escalation events. All tracing is no-op when Langfuse is absent (`TESTING=true`).

---

## Aielia (the assistant)

Aielia is an everyday chat assistant that runs the full TypeScript harness (`@buildaharness/harness`) **client-side, every turn** — no adapter server involved. Its package README (`packages/aielia/README.md`) is the user-facing reference; this section is the structure.

```
 Surfaces (platform plumbing + rendering only)
 ┌──────────────────┐ ┌──────────────────────────┐ ┌─────────────────────────┐
 │ aielia CLI       │ │ chat-ui (browser app,    │ │ desktop (Tauri v2 shell │
 │ readline / Ink   │ │ Chat + Write entries)    │ │ around chat-ui)         │
 └────────┬─────────┘ └────────────┬─────────────┘ └────────────┬────────────┘
          └────────────────────────┴────────────────────────────┘
                                   │  buildAssistantOptions(config, platform)
                                   ▼
 @buildaharness/aielia   assistant.ts  (thin facade + sequencer)
   ├── TurnInterpreter · ActionApprovalService · PlanService · AssistantSession
   ├── MemoryService · ResponseService · HarnessBridge · AgentLoop · tool-policy.ts
   │        │
   │        ▼  one loop: HarnessRuntime.driveMainLoop ⇄ AgentLoop (one tool iteration per step)
   ▼
 @buildaharness/harness  (11 layers, Trajectory Supervisor, ControlState gate)
   ▼
 @buildaharness/runtime  (ILLMClient, MemoryAdapter, ExperienceStore, reminders)
   ├── LLM backend: proxy | anthropic | openai | openrouter | claude-cli (developer testing only)
   └── storage: IndexedDB/Dexie (browser) · filesystem under appLocalDataDir (desktop) · files (CLI)
```

### One implementation per feature

The CLI and the chat app run the same assistant, so a feature is written **once**, in `packages/aielia/src`, as a pure function or small module with no `node:*` and no DOM imports (it is bundled into the browser build), and exported from `index.ts`. A surface holds only what it must have — filesystem, process spawn, HTTP, DNS, the config store, the keychain — and the rendering of what the shared code returns. If a surface needs different behaviour, the difference is a *parameter* of the shared code, not a second copy. The seams that enforce this:

| Seam | What it decides |
|---|---|
| `COMMAND_REGISTRY` (`commands.ts`) | Every slash command, marked `both` or surface-specific with a reason; the CLI's `/help` is derived from it and two tests fail if a surface disagrees with it |
| `presentTurnResult` / `NO_TRACE` (`turn-presentation.ts`) | What a finished turn shows (approval cards, questions, hints, next steps); the CLI prints it, chat-ui renders it, neither reads `AssistantTurnResult`'s status branches |
| `buildAssistantOptions` (`assistant-options.ts`) | How a config becomes assistant options; a surface supplies its client, storage and tools and picks a `features` preset (a parity test snapshots which keys each surface passes) |
| `ENV_KEYS` / `CONFIG_KEYS` (`config-keys.ts`) | One entry makes a setting pinnable by environment variable on the CLI (`ASSISTANT_*`) and the Vite build (`VITE_ASSISTANT_*`) |

### The assistant core

`PersonalAssistant` (`assistant.ts`) is a facade that constructs and sequences single-purpose collaborators:

| Collaborator | Responsibility |
|---|---|
| `TurnInterpreter` | One structured classification per message: intent, risk level, decomposition, whether it continues a stuck plan, constraints, facts worth keeping |
| `AssistantSession` | Transcript, search index (`transcript-msg:<session>:<n>` entries), compaction, session scope |
| `MemoryService` | Durable and session facts, the write path, the audit log (see "Agent memory") |
| `AgentLoop` | The tool-calling machinery: read-only tools, batch research with a turn-wide `Budget`, and the proposers the harness drives |
| `HarnessBridge` | Builds each turn's harness run (checkpoints, layer hooks, verification and contradiction callbacks, supervisor, token budget) |
| `ActionApprovalService` | Stages `write_file` / `run_shell_command` / batch actions for approval, resumes after the user decides, and keeps an undo log |
| `PlanService` and the plan modules | Plan mode, the plan store, drafting, the lightweight sketch, approval, and the plan graph view |
| `ResponseService` | Assembles the reply, the reply audit, constraint checks and the "Why?" data (`answerClaim`) |
| `tool-policy.ts` | Deterministic gate for every tool call |

### Control: what may happen

The model proposes; deterministic code decides. Consequential decisions are never taken from classifier output alone.

- **Turn level.** `evaluateTurnPolicy()` / `evaluateAbandonPolicy()` (`turn-policy.ts`) recompute "needs approval" and "abandon the plan" from structural signals (INV-14). A classifier failure yields `riskLevel: 'UNKNOWN'` with `requiresApproval: true`; `UNKNOWN` maps to `HIGH` when it crosses into the harness's own `LOW/MEDIUM/HIGH` enum.
- **Tool level.** `evaluateToolPolicy()` checks every read-only tool call against a live, turn-scoped `ControlState` (`tool-control-plane.ts`), built from the outcomes of the turn's earlier calls using the harness's own evidence, reliability, world-model and resolver primitives. Under one-loop it is folded with the harness's live per-iteration `ControlState` — whichever restricts more wins (`moreRestrictiveControlState`). A real retry loop is denied once eight failures are counted. Tool effect classes (`tool-effect-class.ts`) feed `deriveConsequentialTools`.
- **Staging.** `write_file`, `run_shell_command` and `send_email` are staged for approval unconditionally, regardless of backend, and never call the read-only gate. Applied actions are recorded in an undo log (`/undo-action`).
- **Spend.** `checkSpendCap()` runs once per turn before any model call; a cap stops all calls once reached.
- **Side calls.** The small structured calls around a reply (classification, scope matching, reply audit, next steps) run under `side-call-policy.ts` so a call that never answers cannot hold a finished-looking turn open.

### One loop

Since 2026-09-06 `ASSISTANT_ONE_LOOP` defaults to `enabled`: the harness's own `driveMainLoop` calls `AgentLoop` one tool iteration at a time (`createHarnessProposer`, `createOneLoopProposer`, `createBatchOneLoopProposer`, threaded in as `HarnessRunParams.oneLoopProposer`), so the 11 layers drive tool calls rather than doing bookkeeping over a finished reply. `=disabled` restores the earlier run-to-completion-then-bookkeeping path (INV-19), kept for one rollout window.

Under the **`claude-cli`** backend (developer testing only — it is not offered in the first-run flow) tool calls resolve inside the `claude` subprocess, so read-only calls reach the same policy through an ephemeral loopback gate (`startToolGateServer()` ⇄ `file-tools-mcp-server.mjs`, `ChatOptions.onToolProposal`). The gate **fails open** on anything unexpected (unparseable response, dead connection, hook error). Tool outcomes are reported back and feed the turn's `ControlState` the same way as on the proxy path.

### Trust, evidence and "Why?"

- **Fact provenance.** Every `UserFact` carries a `FactSource` (`user_asserted`, `model_inferred`, `observed`, `externally_verified`). User-asserted durable facts auto-promote; `model_inferred` facts are gated by confidence (high + durable promotes, medium is queued for `/memory confirm`, low stays session-scoped).
- **Answer claims.** Replies from the tool/research path carry `answerClaim` — evidence, confidence, freshness, source type and a `verification_status` of `verified` / `unverified_attempted` / `contradicted` / `no_evidence`, derived from the harness's real Verification and Contradiction output, never guessed. `verified` additionally needs a bounded grounding check of the reply against the raw tool text (`AUDIT_SEMANTIC_GROUNDING`). Under `claude-cli` no excerpt is visible to the parent, so those turns read `unverified_attempted`.
- **Reply audit.** After the reply is streamed, `reply-audit.ts` checks it against what the turn actually did ("Done, I added it" with no write behind it) and returns a separate notice.
- **Semantic decisions.** Where intent or meaning matters (constraints, contradictions, failure matching, task completion), the decision is a model judgement with a deterministic fallback, not a word match (ADR-007). Use `parseModelJson` for any new parse of model output.

### Layers, flags and user settings

Every behaviour beyond the harness floor ships behind an env flag (`AUDIT_*`, plus `HARNESS_*`) read in exactly one place; `=0`/`off` restores the earlier behaviour. `layer-settings.ts` (`LAYER_SETTINGS`) is the user-facing on/off surface, shared by the CLI (`/layers`, `/layers settings`) and the desktop/browser Settings screen: it writes the persisted `config.layers` choices into the same flags, an operator-set flag wins and shows as pinned, and a layer can carry a `caution`. Layers fall into four groups:

| Group | Layers (default) |
|---|---|
| **floor** | `control_state`, `tool_policy`, `mandatory_verification` (on; may be switched off with a caution), `approval_staging` (locked), `diagnostics` and `hypothesis` (follow `control_state`) |
| **escalation** | `semantic_contradiction`, `failure_match`, `criterion_coverage`, `change_review`, `injection_detection`, `model_inferred_facts`, `reviewer_adversarial` (on); `decomposition_reframe` (off) |
| **behaviour** | `supervisor`, `constraint_check`, `semantic_grounding`, `retry_system_errors`, `plan_step_prompt`, `decomposed_answer_once`, `stuck_plan_resume`, `memory_budgeted_render` (all on) |
| **opt-in** | `semantic_compaction` and `episodic_digest` (on since the H1 default change); `semantic_hypotheses`, `source_reliability`, `reviewer_revision`, `experience_learning`, `semantic_task_completion`, `contradiction_severity`, `code_plan_templates`, `retry_failed_task`, `memory_write_gate`, `memory_audit_log`, `recall_tool`, `memory_consolidation`, `memory_reviewer` (off) |

Mode-valued settings stay `/config set` rather than layer toggles: `goalGraphMode`, `goalGraphSuggestMode`, `oneLoopMode`, `askMode` and `layerPolicyMode` (default `static`; the adaptive policy was evaluated and closed). `planGraphMode` (graph view) is presentation only and not a layer. The browser and desktop builds get a minimal `process.env` from `chat-ui/src/layer-env.ts`. Whether a layer helps is a separate question from whether it is wired: the measured value of each layer is tracked in `docs/layer_value_map.json` and `docs/harness_benchmark_report.md`, and several defaults are on with no measured outcome delta (the base model obeys unaided).

### Agent memory

User memory lives in `memory-service.ts` (with `memory-governance`, `memory-reviewer`, `memory-consolidation`, `episodic-digest` and `recall-tool`), and `commitDurable()` is the only writer of the durable key, so every change passes the audit log. Memory is typed by tier (knowledge, experience/procedural, commitment — INV-16 keeps the last two from being read as beliefs). The write path (ADR-008):

- **Budgeted render** (on): the prompt gets a size-bounded view of memory (`memoryBudgetChars`, default 4000) rather than "the last 20 facts", with keyed supersession so a corrected fact replaces its stale twin.
- **Write gate** (opt-in): semantic secret redaction, an injection judgement and an origin check, with one commit point; fail-closed when a judgement is missing.
- **Audit log** (opt-in): every change keeps a pre-image, so `/memory history` and `/memory undo` work; `/memory forget` stays undoable, `erase` scrubs it.
- **Episodic digests and `recall_memory`** (digests on, recall tool off): a digest is written at the session edge, with a flush before compaction, and a read-only tool retrieves it; retention defaults to 90 days.
- **Post-turn reviewer and consolidation** (opt-in): a staged reviewer proposes facts seen across turns (`memoryWriteMode`: `auto` / `staged` / `user_only`), and consolidation proposes archives for the user to confirm.

The **Python twin** is `adapter/harness/agent_memory/` with the REST router `adapter/memory_api.py` (`/memory/facts`, `/render`, `/pending`, `/history`, `/export`, `/status`, `/off`, `/on`; tables from migration `0013`). It covers store, write gate, audit and budgeted render only — no classifier, digests, reviewer or consolidation — and its record endpoint accepts only user-asserted, user-origin candidates unless the write gate is on. Both languages consume the generated contract `spec/memory-core.json` (`node spec/gen-memory-core.mjs` regenerates `_core_generated.py` and `_memory-core-generated.ts`); edit the JSON, never the generated files. `scripts/harness-conformance/compare-memory.mjs` holds the two implementations equivalent.

### Planning, questions and goals

- **Plan mode** (`ASSISTANT_PLAN_MODE`: `gated` or `legacy`, default `legacy` for the rollout window — in `legacy` the automatic trigger never fires, so the machinery below stays dormant for real traffic): once triggered, a drafting call produces a `PlanRecord` and nothing runs until the user approves it (INV-30, INV-31). Approval can be plain, with edits, or "trust this approved plan" (INV-36). Plans persist as a file snapshot plus the in-memory record (INV-33), a stuck plan resumes only on a message the classifier says continues it, and plan questions are answered from the plan's recorded state. `/plan sketch` is a lightweight read-only delegate (INV-35). `/plan graph` and the chat-ui drawer render the plan as a graph (`planGraphMode`, presentation only; see `docs/plan-visualization.md`).
- **Ask-question mechanism** (ADR-006, `askMode`, default `disabled`): a generic batched-questions flow decoupled from the supervisor; the mechanism is demonstrated at the supervisor site and its default stays off until a multi-seed benchmark justifies flipping it.
- **Goal threads** (`goalGraphMode`, `goalGraphSuggestMode`; on in the CLI and chat-ui, off in the library): a hierarchical goal tree where each message is matched to a `GoalThread`, a single-focus Scheduler is the sole writer of the active pointer, and a paused thread keeps its state (INV-38 to INV-43). It drives steering and next-step options.

### Harness advisor (library modules)

A set of pure modules in `packages/aielia/src` lets a maintainer pipeline *suggest*, validate and adopt changes to the harness itself. They are inert unless an adopted input is supplied: with every slot empty the assistant's prompts pass through byte for byte.

| Module | Role |
|---|---|
| `harness-surfaces`, `advisor-data-surfaces` | Registry of what a suggestion may change, derived from the escalation, behaviour and opt-in layer groups and a few data surfaces; floor layers are not representable |
| `harness-suggestion`, `suggestion-validator`, `suggestion-evidence`, `suggestion-archive` | The typed suggestion (a total `fromJSON` that degrades to a no-op), cheap pre-validation, a four-part evidence record, and an append-only outcome archive |
| `admission-gate` | Decides whether a candidate beat the incumbent on evidence the proposer never saw; labels the result `screen` or `certificate` (at today's corpus size always `screen`) |
| `instruction-fragments` | Four size-capped prompt slots (plan step, verification, failure recovery, tool use) behind a protected base paragraph; the only entry point is the assistant's own system prompt |
| `procedure-library`, `procedure-lifecycle` | Reusable procedures (decomposition, tool workflow, verification plan, recovery sequence) with a draft area, promotion after independent support, a per-class cap, and curator operations |
| `layer-telemetry` | Writes layer-outcome rows (enums, counts, ids and costs only) to the local experience store; never throws |

The advisor never reaches the kernel: tool permission logic, the memory write gate and the floor layers have no surface entry.

### Surfaces

- **CLI** (`aielia`, `packages/aielia/src/cli.ts`): a readline/Ink REPL, installed as a standalone binary or from npm, with a self-update check. Commands come from `COMMAND_REGISTRY`; a few are CLI-only by design (`CLI_ONLY_FEATURES`).
- **chat-ui** (`packages/chat-ui`): the browser app. It has two Vite entries over the same sources: **Chat** and **Write**. Browser web tools (`web_search`, `fetch_url`) use `webBackend: 'direct'` or `'proxy'` (through `@buildaharness/proxy`, which can serve an anonymous, rate-limited `/web/*` to named origins). It has a Playwright browser end-to-end suite and jsdom seam tests.
- **Aielia Write**: a writing page with the assistant beside it. The article is Markdown with sections, claims and their sources, pasted reviewer comments and stated corrections tracked per article; the assistant changes text only as suggestions the user accepts. Everything that is not rendering lives in `packages/aielia/src/writer/` and is exported from the package.
- **Desktop** (`packages/desktop`): a Tauri v2 shell around `chat-ui` with no frontend of its own. It holds Chat and Write in one window (the title drop-down switches between them), stores data under `appLocalDataDir()` through the `fs` plugin, keeps API keys in the OS keychain, and exposes workspace-scoped file, shell and DNS commands from `src-tauri/src/lib.rs`.

---

## npm packages

In addition to the server-side adapter, buildaharness ships six published npm packages (`chat-ui` and `desktop` are private apps in the same workspace):

| Package | Purpose |
|---|---|
| `@buildaharness/canvas` | Embeddable React canvas component (context-scoped store) |
| `@buildaharness/harness` | TypeScript types and node implementations for the harness state structures |
| `@buildaharness/runtime` | Framework-agnostic TypeScript runtime — executes FlowSpec flows without a server |
| `@buildaharness/react` | React hook (`useHarness`) for embedding runtime-driven flows in React apps |
| `@buildaharness/proxy` | LLM proxy that keeps API keys server-side — ships as a Cloudflare Worker or Docker service |
| `@buildaharness/aielia` | Everyday chat assistant (Aielia) that runs the full harness client-side every turn; one shared implementation for the `aielia` CLI, `chat-ui` (Chat and Write) and the desktop app — see [Aielia (the assistant)](#aielia-the-assistant) and `packages/aielia/README.md`. Also ships a standalone CLI binary (installers at myaielia.com) |

### `@buildaharness/harness`

TypeScript implementation of the harness state layer, sharing its pure-data constants with Python from one generated source (`spec/harness-core.json` → `adapter/harness/_core_generated.py` / `packages/harness/src/_core-generated.ts` — thresholds, recovery-dependency tables, `LAYER_TIER`; see "Shared semantic core" below) rather than being hand-copied field-for-field. The ~150-line resolver algorithm itself is still hand-mirrored per language and held equivalent by a conformance fixture suite, not generated — see ADR-004 (shared semantic core) for why. `ControlState.permission`/`execution_mode`/`escalation`/`risk_estimate`/`confidence_estimate` (Python's Phase 1a semantic-contract split) carry over unchanged. Provides typed interfaces for `WorldModel`, `HypothesisSet`, `ControlState`, `TaskGraph`, `EvidenceStore`, `ExperienceStore`, `CallerState`, `OutputContract`, and all associated sub-structures. Also includes the full set of harness node implementations (e.g. `gather-evidence`, `detect-contradictions`, `resolve-control-state`, `execute`, `verify`, `reviewer-pass`). `HarnessRuntime` is a real resumable execution engine, not just types — `run()`/`resume()` drive a generator with two pause points: the default post-execution checkpoint, and a suspend point between `action_gate`'s decision and `execute()` (propose → gate → execute) that a caller can use to inject real approval.

A `toolFn` can additionally report an `ExecutionStatus` of `'continue'` (not just `'complete'`/`'failed'`) via a `ContinuableExecutionOutcome` return value (`{ __harnessExecutionStatus, output?, error? }`) — `driveMainLoop` keeps the task RUNNING and re-suspends at the same `action_gate` point instead of marking it COMPLETE, so a task can signal "more work to do" across a real process restart. This bumped the checkpoint schema to v2 (`CHECKPOINT_MIGRATIONS[1]` upgrades a v1 checkpoint in place) and added an `onGateDecision` callback surfacing what used to be a silent BLOCK/ESCALATE outcome. A `toolFn` can also throw a `HarnessPauseSignal`-marked object (`{ __harnessPause: true }`) to signal a non-failure pause — rethrown untouched, no SYSTEM_ERROR evidence recorded — and `toolExecutors`' values may return a plain value or a `Promise` (`execute()` is `async`). `execute()` additionally passes a `ToolExecutorContext` (`worldModel`, `evidenceStore`, and optional live `controlState` / `diagnostics` / `failureDiagnostics`) to each `toolFn`, so a proposer can gate its own tool calls against the harness's own resolved `ControlState`; a zero-arg `toolFn` written before this ignores the argument.

These primitives are what Aielia's one-loop design drives: `AgentLoop`'s proposers run one tool iteration per `driveMainLoop` step, gated by `ASSISTANT_ONE_LOOP` (default `enabled`; `=disabled` is the byte-identical escape hatch, INV-19). See [Aielia (the assistant)](#aielia-the-assistant) and `packages/harness/README.md`.

### `@buildaharness/runtime`

Executes FlowSpec flows client-side or in a Node.js process without needing the adapter server. All 14 core node types have executors, and so does `process_concept`; the other harness node types are passthrough stubs that emit lifecycle events without changing state (they execute server-side in the adapter). Useful for testing flows in CI without a running stack, or for embedding flows in desktop/Electron apps. It also supplies what Aielia builds on: the `ILLMClient`/`LLMClient` abstraction, the storage adapters (`InMemoryAdapter`, `IndexedDBAdapter`/Dexie, `FileSystemAdapter`) with `DexieExperienceStore` / `FileSystemExperienceStore`, and the reminder store.

### `@buildaharness/react`

`useHarness(flowSpec, options)` hook that wraps `@buildaharness/runtime`. Returns `{ run, resume, abort, reset, status, state, nodeStats, streamingTokens, hitlPrompt, hitlResumeSchema, error, events }`.

### `@buildaharness/proxy`

Thin Hono server that issues short-lived (1-hour) JWTs and forwards LLM requests to Anthropic or OpenAI, keeping API keys off the client. It also serves the `/web/*` search and fetch endpoints that browser builds use when `webBackend` is `proxy`. Deploys to Cloudflare Workers or Docker. See `packages/proxy/README.md` and `docs/env-vars.md`.

---

## Key design decisions

**Neutral spec IR.** The canvas emits a neutral JSON spec. Adapters translate it. Swapping runtimes means updating one adapter file. Canvas, versioning, RBAC, eval, and collab are decoupled from runtime choice.

**TypeScript on XYFlow, not Python on LangFlow.** LangFlow wires components; a harness needs to author state machines. XYFlow gives the right canvas model with a single-language stack and a clean embeddable-package path.

**Langfuse (MIT, self-hosted) over LangSmith.** LangSmith is proprietary SaaS. Langfuse is MIT, self-hostable, OTel-compatible. The Python SDK v4 uses OTel as its native transport, making per-node child spans straightforward via `contextvars.copy_context().run()`.

**ADR-001 as the spec-to-adapter contract.** Four field semantics were left open during spec design. Closing them via ADR means zero breaking changes and a permanent reference for future adapter authors.

**`fn_ref` allowlist over sandboxing.** Generated code is exec'd directly. Full sandboxing is complex and escape-prone. Validating `fn_ref` values at every entry point before any codegen or exec() call is simpler, auditable, and effective.

**The model proposes, deterministic code decides.** In Aielia, approval requirements, tool permission, plan activation and memory writes are recomputed from structural signals (risk level, control state, tier rules) rather than taken from a classifier's say-so; a classifier failure fails safe (`UNKNOWN` risk requires approval). Judgement calls about *meaning* are model calls, never regular expressions (ADR-007).

**One implementation per feature.** A feature is written once in `packages/aielia/src` and every surface (CLI, browser, desktop) renders its result; a surface that needs different behaviour gets a parameter, not a second copy.

**Flags with measured defaults.** A layer ships behind a single env flag, and its default is flipped only on measured evidence; several layers are on with no measured outcome delta and say so in `layer-settings.ts`.

## Further reading

- [flowspec.md](./flowspec.md) — complete FlowSpec v1.0.0 field-by-field reference for all 27 node types
- [env-vars.md](./env-vars.md) — all environment variables across all services
- [qdrant.md](./qdrant.md) — Qdrant vector store setup, seeding, and production deployment
- [plan-visualization.md](./plan-visualization.md) — the read-only plan graph view (`/plan graph`, chat-ui drawer)
- [threat-model.md](./threat-model.md) — trust boundaries and mitigations
- [harness_benchmark_report.md](./harness_benchmark_report.md) and `layer_value_map.json` — what each layer is measured to add
- `packages/aielia/README.md` — the assistant's install, commands, configuration and settings
- `packages/chat-ui/README.md` — the browser app, Write, and the browser end-to-end suite
- `packages/desktop/README.md` — the Tauri shell
