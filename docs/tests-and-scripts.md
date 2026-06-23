# Tests and Scripts

Complete reference for the buildaharness test suites and helper scripts.

---

## Running the tests

```bash
# Frontend — Vitest (schema + canvas store + harness package, no server needed)
npm test

# Adapter — main integration suite (470 tests, SQLite in-memory, no server needed)
pytest adapter/tests/ -v

# Adapter — harness unit tests (P0–P11, all infrastructure-free)
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_p*.py adapter/tests/test_harness_process_concepts.py adapter/tests/test_harness_primitives.py -v --noconftest

# Adapter — harness integration + E2E + invariants (111 tests, all infrastructure-free)
PYTHONPATH=adapter python3.12 -m pytest adapter/tests/test_harness_integration_*.py adapter/tests/test_harness_e2e.py adapter/tests/test_harness_invariants.py -v --noconftest

# Adapter — harness benchmarks (50 runs per operation)
PYTHONPATH=adapter python3.12 adapter/tests/benchmark_harness.py

# Adapter — eval suite (structural tests always run; LLM metrics need EVAL_USE_REAL_LLM=true)
pytest adapter/eval/ -v

# Single file
pytest adapter/tests/test_maf_adapter.py -v
pytest adapter/tests/test_debate_agent_a2a_flow.py -v
```

No running stack is required for any of the above. The adapter tests use an in-memory SQLite database and mock all LLM/external calls. All harness tests are infrastructure-free (no Postgres, no LLM calls).

---

## Adapter — integration tests (`adapter/tests/`)

470 tests total. All run without Docker, Postgres, or real LLM keys.

### API and infrastructure tests

| File | Tests | What it covers |
|---|---|---|
| `test_auth.py` | 13 | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` — JWT issued, email uniqueness, bad credentials |
| `test_logout.py` | 6 | `POST /auth/logout` — 204 response, jti field in tokens, revocation contract |
| `test_flows.py` | 9 | `/flows` CRUD — save, get, list, version bump, ownership isolation |
| `test_spec_and_compile.py` | 36 | `validate_spec` rules · `POST /compile` auth + routing · `_build_initial_state` · security headers |
| `test_deploy.py` | 24 | Unified one-click deploy (REST + MCP + A2A) — deploy, redeploy, undeploy, ownership guards, MCP manifest shape, `POST /flows/{id}/invoke` |
| `test_job_store.py` | 11 | Postgres job store — create, status, TTL eviction, isolation between users, A2A task rows |
| `test_eval.py` | 18 | `/eval/score`, `/eval/feedback`, `/eval/templates`, `/eval/scores` — auth guards, 404 on wrong owner |
| `test_prompts.py` | 13 | `/prompts` list + fetch · `resolve_prompts()` — cache hit/miss, mixed flows, graceful fallback |
| `test_logout.py` | 6 | Token revocation contract in TESTING mode (Redis no-op) |

### Auth and multi-tenancy tests

| File | Tests | What it covers |
|---|---|---|
| `test_sso.py` | 30 | OIDC login, callback, user provisioning, group→role mapping, token refresh with replay prevention, SCIM 2.0 (list/get/deactivate), SSO-provisioned account login block |
| `test_namespacing.py` | 38 | Personal org auto-creation, org CRUD, member roles, Langfuse key management, last-admin guard, flow isolation across orgs, multi-tenant `X-Org-Id` header routing |
| `test_teams.py` | 22 | Team creation, membership, role assignment, team-scoped flow sharing |
| `test_marketplace.py` | 20 | Component marketplace — publish, search, filter, install, duplicate slug guard, install count increment |

### A2A protocol tests

| File | Tests | What it covers |
|---|---|---|
| `test_a2a.py` | 28 | `generate_agent_card()` · `GET /.well-known/agent/{id}.json` · `POST /deploy/a2a/{id}` (deploy, idempotent, 400 when disabled, 403 wrong owner) · `DELETE /deploy/a2a/{id}` · `POST /a2a/{id}/tasks/send` (202, 400, 409 duplicate, 422 empty id) · `GET /a2a/{id}/tasks/{task_id}` · `GET /a2a/{id}/tasks/{task_id}/events` (SSE auth guard) |

### Adapter / codegen tests

| File | Tests | What it covers |
|---|---|---|
| `test_maf_adapter.py` | 42 | MS Agent Framework adapter — all 14 node types, `agent_debate → AgentGroupChat`, `agent_role → ChatCompletionAgent`, `hitl_breakpoint → _HitlPause`, `parallel_fork/join → asyncio.gather`, condition routing, `POST /compile?runtime=microsoft_agent_framework`, HITL resume, `NODE_SUPPORT_MATRIX` |
| `test_mastra_runner.py` | 11 | Mastra sidecar integration — `/runtimes` reports mastra executable, `POST /run?runtime=mastra` creates a job, background task drives job to `done`/`error`, sidecar-unreachable error path |

### Example flow end-to-end tests

These tests compile each reference flow spec through all four adapters, then execute the generated code with mocked LLMs — no real API keys or running services needed.

| File | Tests | Flow | What it covers |
|---|---|---|---|
| `test_rag_flow.py` | 34 | [01 — RAG Agent](../flows/01-rag-agent-flow.json) | Compile (all 4 adapters) · LangGraph e2e with seeded Wikipedia chunks · `memory_read` semantic · `transform fn_ref` · retrieval answer contains expected content |
| `test_content_moderation_flow.py` | 33 | [02 — Content Moderation + HITL](../flows/02-content-moderation-hitl-flow.json) | Compile (all 4 adapters) · LangGraph e2e low/medium/high severity · HITL `interrupt()` + `Command(resume=...)` · MAF `_HitlPause` raised and `node_id` correct |
| `test_parallel_risk_assessment_flow.py` | 35 | [03 — Parallel Risk Assessment](../flows/03-parallel-risk-assessment-flow.json) | Compile (all 4 adapters) · LangGraph e2e `parallel_fork/join` · MAF `asyncio.gather` fan-out · OTel/Langfuse tracing setup · synthesise node receives all branch results |
| `test_debate_agent_a2a_flow.py` | 47 | [05 — Debate Agent + A2A](../flows/05-debate-agent-a2a-flow.json) | A2A AgentCard unit tests · Compile (all 4 adapters) · MAF `AgentGroupChat` native + VERDICT termination · LangGraph node-level tests for `prepare_position`, turn-loop termination, and `format_output` mapping |

#### What the compile tests verify (per adapter, per flow)

Each flow test class (`TestLangGraphCompile`, `TestMAFCompile`, `TestCrewAICompile`, `TestMastraCompile`) verifies that the generated code:

- Contains the expected node function names
- Wires graph edges correctly
- Emits the right adapter-specific primitives (e.g. `interrupt()` for LangGraph HITL, `_HitlPause` for MAF, `suspend()` for Mastra)
- Emits the correct warning count for partially-supported node types
- Includes telemetry setup when `flow_config.telemetry.enabled = true`

---

---

## Adapter — harness tests (`adapter/tests/test_harness_*.py`)

470 tests in the harness suite. All infrastructure-free — no Postgres, no LLM keys, no running services. All tests use `--noconftest` to run without the SQLite fixture from `conftest.py`.

### Phase unit tests

| File | Tests | What it covers |
|---|---|---|
| `test_harness_p0.py` | 29 | Foundation: `WorldModel`, `generation_id`, staleness tracking, `CallerState`, `OutputContract` stubs, `HarnessRunState` |
| `test_harness_p1.py` | 26 | Evidence: `Evidence`, `EvidenceStore`, tool reliability envelopes, `ToolAvailabilityManifest`, hypothesis generation (4 sources), elimination policy, diversity enforcement |
| `test_harness_p2.py` | 18 | World Model ops: `integrate_evidence`, `BeliefDepGraph`, belief propagation, contradiction detection (pairwise / temporal / abstraction), resolution policy, staleness sweep |
| `test_harness_p3.py` | 20 | Diagnostics: 10 normalised sub-dimensions, `resolve_control_state` 5-tier, deadlock detection, `select_best_action`, `run_one_iteration` |
| `test_harness_p4.py` | 13 | Planning: `TaskGraph`, 6-state task status, `ConflictProbabilityCache`, `parallel_merge`, `reconcile_parallel_branches` |
| `test_harness_p5.py` | 45 | Execution: risk estimation, VOI gating, `verify` (9 layers), `review_gate` (5 dimensions), `execute`, `ReversibilityStrategy`, `contract_shadow_check` |
| `test_harness_p6.py` | 18 | Recovery: `StrategyState`, `FailureModeLibrary`, `cannot_make_progress` (4 stall proxies), `diagnose_and_replan`, `compress_memory`, `check_max_steps` |
| `test_harness_p7.py` | 9 | Caller updates & escalation: `UpdateChannel`, `check_external_updates`, `apply_constraint_change_propagation`, `escalate`, `await_clarification` |
| `test_harness_p8.py` | 16 | Experience store: `warm_start`, `update_experience_store`, softmax strategy weights, no-op path when `experience_store.available = False` |
| `test_harness_p9.py` | 15 | Reviewer pass: `seed_adversarial_prior`, `compute_causal_proximity`, `reviewer_pass` (10-step), adversarial prior discarded after use (INV-09), `completion_check_final`, `validate_output_contract` |
| `test_harness_p10.py` | 30 | Canvas node compilers: all 9 harness node types — schema validation + `exec()` correctness, `HARNESS_NODE_COMPILERS` dispatch table |
| `test_harness_process_concepts.py` | 38 | Process concepts: `ProcessConcept`, `ProcessRegistry`, `seed_task_graph`, `load_process`, `get_current_step`, `complete_step`, idempotency (INV-PC-05), hard error on missing concept (INV-PC-04) |
| `test_harness_primitives.py` | 83 | G-series primitives: `TurnContextBootstrap` (G-2), `FeedbackPreferenceExtractor` (G-3), `MultiSourceDiversityReducer` (G-4), `TaxonomyClassifier` (G-5), `SessionCloseFactory` (G-6) |

### Integration, E2E, and invariant tests

| File | Tests | What it covers |
|---|---|---|
| `test_harness_integration_LG.py` | 16 | LangGraph adapter: harness spec compiles, preamble generated, all 12 node types compile, non-harness path unaffected |
| `test_harness_integration_CR.py` | 16 | CrewAI adapter: same 4 checks |
| `test_harness_integration_MA.py` | 16 | Mastra adapter: same 4 checks (TypeScript stubs) |
| `test_harness_integration_MAF.py` | 16 | MS Agent Framework adapter: same 4 checks |
| `test_harness_e2e.py` | 32 | 8 scenarios × 4 frameworks: happy path, BLOCKED escalation, recovery cycle, warm-start, parallel branch merge, context compression, reviewer re-entry, max_steps budget |
| `test_harness_invariants.py` | 18 | INV-01 through INV-10 as permanent CI gate — black-box observable-behaviour assertions; includes multi-case tests for INV-03, INV-04, INV-05, INV-06, INV-10 and three plan-level invariant tests |

### Performance benchmarks

`adapter/tests/benchmark_harness.py` — 50-run benchmarks with `time.perf_counter()`. Results as of P11:

| Operation | Mean (ms) | Target | Status |
|---|---|---|---|
| `run_one_iteration` (full loop overhead) | 0.11 | < 500 ms | **✓** |
| `generate_hypotheses` | 0.23 | < 200 ms | **✓** |
| `propagate_beliefs` | < 0.01 | < 100 ms | **✓** |

Harness adds negligible overhead relative to any LLM inference call. See `docs/harness_benchmark_report.md` for full results.

---

## Adapter — eval suite (`adapter/eval/`)

34 tests total. Structural tests always run; LLM-metric tests require `EVAL_USE_REAL_LLM=true` and `OPENAI_API_KEY`.

```bash
# Structural tests only (default — no LLM)
pytest adapter/eval/ -v

# Full metric tests
EVAL_USE_REAL_LLM=true pytest adapter/eval/ -v
```

| File | Tests | What it covers |
|---|---|---|
| `test_spec_validation.py` | 9 | All five reference flows parse the schema without errors and compile to all four adapters without syntax errors — a compile-gate that must pass before metric tests run |
| `test_debate_quality.py` | 17 | Debate flow (flow 05) structural checks (node types, AgentGroupChat termination keyword) + LLM-gated metrics: `ArgumentCoherenceMetric` (threshold 0.7), `VerdictQualityMetric` (threshold 0.7), `TranscriptStructureMetric` |
| `test_moderation_quality.py` | 4 | Content moderation flow structural checks + LLM-gated metrics: `TaskCompletionMetric` (threshold 0.8), `HallucinationMetric` (max 0.2) |
| `test_rag_quality.py` | 4 | RAG flow structural checks + LLM-gated metrics: `AnswerRelevancyMetric` (0.7), `FaithfulnessMetric` (0.7), `ContextualRecallMetric` (0.6) |

Thresholds are configurable via environment variables — see each file's header for the variable names.

---

## Frontend tests (`src/spec/schema.test.ts`, `packages/canvas/src/store/create.test.ts`)

Run with `npm test` (Vitest).

| File | What it covers |
|---|---|
| `src/spec/schema.test.ts` | `parseFlowSpec` / `assertFlowSpec` round-trips · all 14 node types · edge types · `validateCrossRefs` · invalid spec rejection · all example flows pass validation |
| `packages/canvas/src/store/create.test.ts` | `createCanvasStore` isolation · `onSpecChange` subscription · `loadFlow → exportSpec` round-trip · undo/redo · multiple simultaneous instances don't share state |

---

## Scripts (`scripts/`)

All scripts run from the project root. Credentials are read from `.env` unless overridden by environment variables.

### Setup and environment

| Script | Purpose |
|---|---|
| `setup-env.sh` | First-time and repair setup — generates secrets, writes `.env` and `.env.local`, optionally creates the Python venv. Safe to re-run: existing real values are never overwritten. |
| `check-env.sh` | Validates all required secrets are set in `.env` (correct format and length). Exits 1 if any check fails. |
| `reset-volumes.sh` | Stops all containers and wipes the Postgres, Redis, and Clickhouse data volumes. Use when Postgres rejects a password after a secret rotation. **All data in those volumes is lost.** |
| `setup-ollama.sh` | Tests all four adapters end-to-end against a local Ollama server using `flows/06-ollama-simple-flow.json`. Supports `RUNTIME=langgraph` to target a single adapter and `TEST_EMAIL` / `TEST_PASSWORD` for non-interactive CI use. |

### Running flows

| Script | Purpose |
|---|---|
| `run.sh` | Unified flow runner for any adapter. Usage: `./scripts/run.sh [--runtime <adapter>] <spec-file.json> [key=value ...]`. Follows the job to completion and handles HITL pause/resume interactively. Falls back to `runtime_hints.preferred_adapter` from the spec when `--runtime` is omitted. |
| `run_langgraph.sh` | LangGraph-specific wrapper. Prompts for credentials, submits the flow, handles HITL pauses, and streams node events. |
| `run_mastra.sh` | Mastra-specific wrapper. Same as above; communicates with the Node.js sidecar. |
| `run_maf.sh` | MS Agent Framework wrapper. Re-sends the full spec on resume so the server can recompile after a restart. |
| `run_crewai.sh` | CrewAI wrapper. Note: CrewAI handles `human_input=True` natively within the crew; the job will not pause for external HITL input. |

All run scripts accept `BASE_URL`, `TEST_EMAIL`, and `TEST_PASSWORD` environment variables to skip interactive prompts.

### Verification and regression

| Script | What it checks |
|---|---|
| `verify_services.sh` | Every Docker container is running and healthy · HTTP endpoints respond correctly · Redis PING · PostgreSQL `pg_isready` · Langfuse API auth · inter-service connectivity from inside the adapter container |
| `verify_llm.sh` | Three-layer LLM path test: Layer 1 — Ollama direct (`localhost:11434`); Layer 2 — LiteLLM proxy (`localhost:4000`); Layer 3 — adapter flow execution. Each layer can fail independently for precise diagnosis. |
| `verify_hitl.sh` | HITL regression for LangGraph, Mastra, and MAF using `flows/07-minimal-hitl-test-flow.json` (no LLM, always pauses). Submits → polls for `paused` → asserts `hitl_state` fields → resumes → polls for `done` → asserts non-empty result. |
| `verify_observability.sh` | Langfuse tracing for all four runtimes — submits the Ollama simple flow, polls to completion, asserts `trace_id` and `trace_url` are present, waits for OTel batch flush, then verifies the trace appears in Langfuse. |
| `verify_prompts.sh` | Three-layer Langfuse prompt test: Layer 1 — Langfuse REST API directly (Basic auth); Layer 2 — adapter HTTP proxy (`GET /prompts`); Layer 3 — adapter SDK resolve during a real job (`prompt_ref` in spec). Catches SDK credential failures that the HTTP proxy cannot detect. |

### Data utilities

| Script | Purpose |
|---|---|
| `scripts/ingest_rag_data.py` | Seeds the Qdrant `knowledge_base` collection with Wikipedia articles split into sentence-level chunks. Used to populate data for RAG flow testing. Configurable via `QDRANT_URL`, `EMBED_BASE_URL`, `EMBED_MODEL`, and `COLLECTION` environment variables. |

---

## Test configuration

The adapter test suite is configured in `adapter/tests/conftest.py`:

- Uses an **in-memory SQLite database** (not Postgres) — no Docker or running DB needed
- Sets `TESTING=true` which disables Redis checks, skips real Langfuse SDK calls, and uses per-call unique rate-limit keys
- Provides `client` (async HTTPX test client), `auth_headers`, and `db_engine` fixtures shared across all test files

The eval suite has its own `adapter/eval/conftest.py` with a `needs_real_llm` fixture that gates LLM-dependent tests behind `EVAL_USE_REAL_LLM=true`.
