# Python harness vs TS harness: mismatches (make Python follow TS)

**Branch: `semantic-constraint-check`** (latest remote branch, 2026-09-30 10:12 UTC). The first pass was written on `main`; every item was re-checked against this branch's diff (`main...HEAD`, incl. its Python changes) and is marked below. Items marked **RESOLVED on this branch** no longer need action.

Scope: `adapter/harness/*.py` vs `packages/harness/src/**`. TS is the reference.
Method: static, side-by-side read of each paired module. I did **not** run `scripts/harness-conformance/*` (no `node_modules` in this checkout).
Only `resolve_control_state`, `verify` (status only), `ask_question` and `supervisor` have cross-language fixtures today. Everything below outside those is unguarded.

### Changes on this branch that affect this list
* **RESOLVED:** TS `reviewProposedChange` now runs all 5 dimensions and collects every failure (matches Python). Python's docstring/§9 note "TS short-circuits" is obsolete. `applyReviewOutcome` accepts a list in both.
* **RESOLVED (mechanism):** `HARNESS_LEXICAL` switches (`harness_lexical_active` / `harnessLexicalActive`) now exist on both sides for: `negation-pairs` (pairwise **and** set-level), `granularity-markers`, `criterion-scope`, `system-error-symptoms`, `failure-exact-match`, `review-negation`, `review-phrases`, `constraint-negation`, `required-sections`, `criterion-substring`, `criterion-proximity` (TS) / `assumption-overlap`, `evidence-negation`, `failure-class-seed` (Py), `change-scope-keywords` (Py, returns 0.0 to mimic TS). **Now aligned (this work):** the Python-only switches (`assumption-overlap`, `evidence-negation`, `failure-class-seed`, `change-scope-keywords`, `required-sections`, `hypothesis-*`) were removed together with the Python-only checks they guarded, and `criterion-proximity` was added, so both runtimes expose the same 12 checks.
* **NEW TS-only (add to Python):** `semanticConstraintJudge` hook + `outputValidation(..., {skipCallerConstraints})`; budget-answer handling (`takeBudgetAnswers`, `DEFAULT_BUDGET_EXTENSION=10` exported from `ask-question.ts`, "Continue" extends `maxSteps`, "Stop" cancels); `semantic_compaction` opt-in layer in `layer-policy.ts` (`AUDIT_SEMANTIC_COMPACTION`); false-budget-halt fix when all tasks COMPLETE; resume polls the budget answer before halting. Ported: `DEFAULT_BUDGET_EXTENSION` and `external_updates.take_budget_answers`. Not ported: the semantic constraint judge, the `semantic_compaction` layer and the all-tasks-COMPLETE budget shortcut (they live in the async runtime).

## Fix status (Python brought in line with TS)

Legend: ✅ fixed on this branch · 🟡 done with a documented, deliberate difference · ⬜ not done (needs a decision or is out of scope)

Verified with `adapter/tests` (harness suites: 950+ passing; the one pre-existing failure `test_inv_plan_export_never_raises`
is unrelated and fails identically on the base branch). The old Python-only behaviour that TS does not have was removed and
its tests rewritten to the TS behaviour; new coverage is in `adapter/tests/test_harness_ts_parity.py`.

| § | Item | Status |
|---|---|---|
| 0 | `handle_escalation_response`, `escalate_budget_exhausted`, `cancel_task_graph`, `experience_learning` (`learn_from_journal`…), `output_validation`, `context_compression`, `estimate_voi`, `select_task`, `update_task_graph`, `rollback_and_replan`, `StrategyState.recovery_strategy_order` | ✅ |
| 0 | `_maybe_resolve` resolves in place + `resolver` argument | ✅ |
| 0 | Budget-answer handling (`take_budget_answers`, `DEFAULT_BUDGET_EXTENSION`) | ✅ |
| 0 | `HarnessRuntime` / `driveMainLoop` (sync twin in `harness/runtime.py`, see §20), `initialize_harness` building all state (`initialize_harness_state`) | ✅ |
| 0 | layer policy/budget/outcome, turn signals, golden baseline, `semantic_compaction` layer | ⬜ out of scope: TS app-layer concerns (see §20) |
| 0 | checkpoints (`harness-checkpoint`), pause/resume, `pendingProposal` replay | ✅ see §20 phase 5b |
| 0 | `semanticConstraintJudge` hook | ✅ (`HarnessRunOptions.semantic_constraint_judge`) |
| 20 | Runtime-vs-loop ordering audit, `resolve_supervisor_directive`, `coerce_for_wired_actions`, `resolve_gather_evidence`, `validate_recovery_action_dependencies` | ✅ |
| 20 | Python-only features bridged into `HarnessRuntime` (phase 1): `RecoveryBudget` (stall halt + plan-revision consumption), `plan_store.save_plan` export each iteration, `on_node` tracing hook, DB-backed `ExperienceStore` (warm start + completion capture), `task_class`/`execution_context` | ✅ |
| 20 | Phase 2: no production code calls `run_one_iteration` (only tests), so it is kept as a documented LEGACY skeleton instead of being rewritten (a rewrite would change ~50 tests' semantics for no caller). `HarnessRuntime`/`initialize_harness_state` are exported from `harness`. The canvas node compilers (the real production consumers of the harness) were verified by exec'ing their generated code on runtime-built state (`test_harness_compiled_nodes_on_runtime_state.py`); fixed `gather_evidence` emitting float `freshness` (TS uses ISO strings) | ✅ |
| 20 | Phase 3: the crewai/langgraph/maf generated preambles build their `HarnessRunState` via `runtime.build_harness_run_state` (TS `initializeHarness` seeding: default failure-mode library, internal evidence sources, journal retention) instead of bare constructors | ✅ |
| 20 | Phase 4: semantic hypotheses (`semantic_hypotheses` / `semantic_hypothesis_judge` hooks, once-per-run generation, per-iteration judging, fail-open) and `reviewer_revision` (reopens the last completed task once) in `HarnessRuntime` | ✅ |
| 20 | Phase 5a (wire shapes): every state structure's `to_dict()` now validates against a mirror of the TS zod schemas (`adapter/tests/ts_state_schemas.py`, 39 checks incl. populated state and round trips). Fixed: `Belief.contradicts` (Python-only, now rebuilt by `WorldModel.from_dict`), `BeliefDepGraph.dep_graph_quality`, `Task.completed_evidence` no longer serialised; `Task.block_reason` omitted when unset; `CallerState.last_update` and `Diagnostics.dep_class_gap_annotation` never null | ✅ |
| 20 | Phase 5b: `harness/checkpoint.py` (TS `harness-checkpoint.ts`: schema v2, v1 migration, `CheckpointSchemaError`, store save/load/delete) and `HarnessRuntime.start()/resume()`; `drive_main_loop` is a generator yielding at the TS suspend points (proposal before execute, continuation, end of iteration). Wire format is the TS one (camelCase top level, TS state shapes), so a checkpoint can be resumed by either runtime. `run()` stays the no-pause convenience | ✅ |
| 1 | `update_diagnostics` (all ten dimensions, dep-class-gap annotation, matched pattern, TS signature, `normalise` input forms) | ✅ (function ported; the Python loop still does not call it per iteration — it never did) |
| 2 | Belief graph (`derived_from_edges`, `verified`, list frontier, `{source,target}` queue, decay 0.05, single-pass `propagate_beliefs`) | ✅ |
| 2 | `update_world_model` / `recompute_belief_health`, staleness sweep on `affected_paths`, `Belief.applied_contradiction_ids`/`pending_sweep`/`reliability` persisted | ✅ |
| 2 | ISO-string vs `datetime` timestamps (`Belief.recorded_at`, `Observation.recorded_at`) | 🟡 wire format is ISO in both; Python keeps `datetime` in memory. `Evidence.freshness` is now an ISO string as in TS |
| 3 | `estimate_risk` (module type, file centrality, change scope), `estimate_voi` | ✅ (Python-only `verification_adequacy_critic` etc. removed) |
| 4 | `HypothesisSet` (`active`/`eliminated`/`elimination_policy`), `generate_update_hypotheses`, diversity loop, pruning, `separating_check` | ✅ |
| 5 | Contradictions: descriptions, policy applied by `detect_contradictions`, `affected_paths`, HIGH no longer blocks tasks, lexical gates | ✅ |
| 6 | `split_ws`, `add_constraint`/`add_success_criteria`, `cancel_current`, propagation bumps generation + clears flag, dedupe | ✅ |
| 6 | Python `user_clarification` observation | 🟡 kept (TS documents the same outcome for its resumed run) |
| 6 | `format` string on `OutputContract` (legacy `format_requirements` still read) | ✅ |
| 7 | Task graph: TS statuses, `set_status` rules, conflict cache on the graph, `select_task`, `GraphCycleError`, orphan-only `validate_task_graph` | ✅ |
| 8 | Parallel merge (`ParallelBranch`, later-wins union, resolver injection, ×0.9 decay) | ✅ |
| 9 | Review gate: confidence ≥ 0.8, `required_sections`, `hypothesis_set.active`, JSON-quoted reasons; `escalate_review_failure`; `diagnose_review_failure_options` per review dimension | ✅ |
| 9 | Review gate is not called by the Python loop (there is no "proposed change" step) | ⬜ available as a function only |
| 10 | `execute`: change-type strategy, rollback points, continuable outcomes, pause signal, symptom regexes, change-log shape, `ToolExecutorContext` | ✅ |
| 11 | Verify `output_contract_partial` (tracked discrepancy), evidence `.observations`, hypotheses `.active` | ✅ — `known-discrepancies-verify.json` is now `{}` |
| 12 | Fixed stall constants, `cannot_make_progress(strategy, failure)`, `diagnose_and_replan`/`rebuild_task_graph`/`requeue_failed_leaves`, `rollback_and_replan`, next-strategy index −1, experience ordering with `"<strategy>:<class>"` keys | ✅ |
| 12 | Python-only `RecoveryBudget` (plan revisions) alongside the TS-shaped `Budget` | 🟡 kept (drives escalation in the Python loop) |
| 12 | Python loop replans GLOBAL on a stall (TS `rollbackAndReplan`'s `noProgress` branch) | ✅ |
| 13 | `MemoryState` shape (token budget object 200000, dependent_tasks, typed journal, rollback points), pressure-based compression, retention order, feasibility cap at 0.5 | ✅ |
| 14 | `InMemoryExperienceStore` / `UnavailableExperienceStore`, `warm_start_from_store`, `learn_from_journal` | ✅ |
| 14 | DB-backed `ExperienceStore` (promotion boundary, offline eval) | 🟡 kept: it is Python's production store; `warm_start` dispatches to the TS semantics for TS-shaped stores |
| 15 | Reviewer pass: three string-finding lenses, BFS adversarial seeding, pending verdict, reopened ids returned (caller reopens) | ✅ |
| 16 | `FailureModeLibrary` (entries/symptoms/class priors), `MatchResult`, `FailureRecord`, evidence store with envelopes/manifest, `apply_tool_reliability`, `gather_evidence` | ✅ |
| 17 | `contract_shadow_check` (`required_sections`), `output_validation` + `OutputContractError`, `update_output_contract` quote stripping | ✅ |
| 18 | Ask-question: review-failure question text and dimension options; `completion_check_final` halts plainly | ✅ |
| 19 | Supervisor: `decide_supervisor_directive` (litellm) is Python-only; `coerce_for_wired_actions` has no twin | 🟡 |
| — | Python-only modules (`plan_store`, `plan_schema`, `execution_boundary`, `provenance`, `semantic_checks`, `langfuse_tracing`, `tool_manifest`, `node_compilers`, `state_store`) | ⬜ decide per module whether TS should gain them |
| — | `harness-runtime.ts` vs `loop.py` step ordering | ⬜ not audited line by line |

### Changes on this branch that affect this list
* **RESOLVED:** TS `reviewProposedChange` now runs all 5 dimensions and collects every failure (matches Python). Python's docstring/§9 note "TS short-circuits" is obsolete. `applyReviewOutcome` accepts a list in both.
* **RESOLVED (mechanism):** `HARNESS_LEXICAL` switches (`harness_lexical_active` / `harnessLexicalActive`) now exist on both sides for: `negation-pairs` (pairwise **and** set-level), `granularity-markers`, `criterion-scope`, `system-error-symptoms`, `failure-exact-match`, `review-negation`, `review-phrases`, `constraint-negation`, `required-sections`, `criterion-substring`, `criterion-proximity` (TS) / `assumption-overlap`, `evidence-negation`, `failure-class-seed` (Py), `change-scope-keywords` (Py, returns 0.0 to mimic TS). **Now aligned (this work):** the Python-only switches (`assumption-overlap`, `evidence-negation`, `failure-class-seed`, `change-scope-keywords`, `required-sections`, `hypothesis-*`) were removed together with the Python-only checks they guarded, and `criterion-proximity` was added, so both runtimes expose the same 12 checks.
* **NEW TS-only (add to Python):** `semanticConstraintJudge` hook + `outputValidation(..., {skipCallerConstraints})`; budget-answer handling (`takeBudgetAnswers`, `DEFAULT_BUDGET_EXTENSION=10` exported from `ask-question.ts`, "Continue" extends `maxSteps`, "Stop" cancels); `semantic_compaction` opt-in layer in `layer-policy.ts` (`AUDIT_SEMANTIC_COMPACTION`); false-budget-halt fix when all tasks COMPLETE; resume polls the budget answer before halting. Ported: `DEFAULT_BUDGET_EXTENSION` and `external_updates.take_budget_answers`. Not ported: the semantic constraint judge, the `semantic_compaction` layer and the all-tasks-COMPLETE budget shortcut (they live in the async runtime).

Legend: **[B]** behaviour differs (outputs diverge), **[M]** missing in Python, **[S]** shape/API/default differs.

---
## 0. Whole subsystems that exist only in TS (missing in Python) [M]

| TS file | What it does |
|---|---|
| `harness-runtime.ts` (2054 lines: `HarnessRuntime`, `driveMainLoop`, `resume`) | Async run driver: semantic hooks (`contradictionChecker`, `semanticChangeReviewer`, `semanticFailureMatcher`, `SemanticHypothesesHook/Judge`, `SemanticTaskCompletion`), gate/layer-activity events, pause/resume, budget-exhausted flow, `0.8*maxSteps` warn. Python only has sync `loop.run_one_iteration()`; hooks live outside the harness. |
| `harness-checkpoint.ts` | `HarnessCheckpoint`, `CHECKPOINT_SCHEMA_VERSION`, `CHECKPOINT_MIGRATIONS`, `CheckpointStore`, save/load/delete, `CheckpointSchemaError` |
| `harness-run-state.ts` | `computeRunState`, `HarnessRunRecord`, `HarnessRunConfigData` etc. Python has `state_store.py` instead (different persistence model) |
| `layer-policy.ts`, `layer-policy-mode.ts`, `layer-policy-rules.ts`, `layer-budget.ts`, `layer-outcome.ts` | Adaptive layer policy (`resolveLayerPolicy`, `LAYER_CLASS`, floor/escalation/opt-in layers, `ADAPTIVE_RULES_V1`, call budget, shadow reports, `LAYER_CALL_COST`, `reevaluateLayerPolicy`, `learnFromJournal` hooks) |
| `turn-signals.ts` | `TurnSignals`, `RunState`, `resolveTurnTier`, `isCalmTurn`, `computeTurnCallBudget` |
| `experience-learning.ts` | `learnFromJournal`, `journalEntryFor`, `recoveryAttempts`, `failureClassOf`, `LEARNING_RATE=0.3`, `PRIOR=0.5` (EMA update of strategy weights + class priors) |
| `nodes/output-validation.ts` | `outputValidation()` + `OutputContractError` (format / sections / interface constraints / validation_rules / caller-constraint negation) |
| `nodes/context-compression.ts` | `contextCompression()` orchestrator (pressure → compress → staleness sweep → dep-graph decay → journal retention) |
| `nodes/estimate-voi.ts` | `estimateVOI()` (see §3) |
| `golden/static-baseline.*`, `scripts/golden-baseline.ts` | Static baseline / `HARNESS_SCENARIOS`, `reconcileGolden`, shadow report |
| `generation-id.ts` `_maybeResolve(..., resolver)` | Resolver injection; Python `_maybe_resolve` has no resolver arg |
| `nodes/escalate.ts`: `validateAskQuestion`, `validateAskAnswer`, `handleEscalationResponse`, `escalateBudgetExhausted`, `awaitClarification` (sync, throws) | Python has validation in `__post_init__`, but **no** `handle_escalation_response` (the shared constraint-propagation entry the TS one calls), no `escalate_budget_exhausted`; its `await_clarification` is a DB poll (different contract) |
| `nodes/rollback-replan.ts`: `rollbackAndReplan`, `buildStrategyOrdering`, `requeueFailedLeaves` | Python splits across `recovery.py`/`replanning.py`/`progress.py`. See §5 |
| `nodes/check-caller-updates.ts`: `cancelTaskGraph`, `AsyncFnUpdateChannel`, `RESTART_ITERATION`, `cancel_current` handling | No `cancel_task_graph`; `goal_cancelled` block reason absent |
| `state/strategy-state.ts` `recovery_strategy_order` field | Python `StrategyState` lacks it |

---
## 1. Diagnostics (`update-diagnostics.ts` vs `diagnostics.py`) [B]

| Dimension | TS | Python |
|---|---|---|
| Function signature | `updateDiagnostics(worldModel, hypothesisSet, taskGraph, failureDiagnostics, depGraph, diagnostics, force)` | `update_diagnostics(diagnostics, world_model, hypothesis_set, evidence_store, task_graph, execution_journal, force)` (no dep graph, no failure diag; adds journal) |
| `belief_health.freshness` | `1 - stale_true_count/max(1,#beliefs)` via `normalise` | reads `world_model.stale_flag_ratio` attr (default 0.0); **no such field on WorldModel** ⇒ always 1.0 |
| `consistency` | density capped at 1 | uncapped (clamped after) |
| `support` | mean of reliability weight `HIGH 1.0 / MED 0.5 / LOW 0.0` (default 1.0 if no beliefs) | `world_model.belief_health_proxies["support"]` (default 1.0); the proxy itself (`recompute_belief_health`) hard-codes 0.5 for every belief. Also the doc says LOW=0.2 |
| `symptom_coverage` | `min(1, #active hyp / max(#observations,1))`, 0 if no active hyp | explained/all symptoms (`target_symptoms` + evidence `symptom_tag`); 1.0 if none |
| `explanation_coverage` | Shannon-entropy of generation sources (`computeSourceEntropy`) | share of hypotheses with evidence; 1.0 if none |
| `verification_health.strength` | `1 - depGraph.unverified_edge_ratio` | not touched here |
| `feasibility` | composite `[toolAdequacy(0.8 if completeness_flags else 0.6), evidenceAdequacy(0.8 if obs else 0.4), abstractionFit]` weights `[1,1,0.3]`, recomputed every call | `0.3*alignment + 0.7*current` only when `task_graph.changed` or force (compounding, stateful) |
| `progress_rate` | `completed/attempted` when attempted≥3 else 1.0; attempted = COMPLETE+FAILED tasks in **task graph** | `completed/total` over **execution_journal** (`status=="completed"`) when total≥3 |
| `failure_recurrence` | `min(1, failure_history.length/10)` | share of most frequent `failure_mode` in journal |
| `oscillation_score` | `failedTasks/totalTasks` (attempted≥3) | risk-state reversal ratio from journal |
| `matched_pattern` | computed here with `normalise(match_confidence)` | not computed here |
| `dep_class_gap_annotation` | computed here (`Abstraction class gaps detected: gap between level a and b`) | not computed in `update_diagnostics` |
| `checkAbstractionAlignment` | in `update-diagnostics.ts` | in `task_graph.py` (logic same) |

`estimate_world_model_granularity` matches.

## 2. World model / belief graph / staleness [B][S]

* `BeliefDepGraph`: TS has `belief_nodes[]`, `derived_from_edges[{from,to,confidence,verified}]`, `invalidation_frontier: string[]`, `propagation_queue: {source_belief_id,target_belief_id}[]`, `unverified_edge_ratio` (edges with `verified=false`), `confidence_decay_rate=0.05`. Python has `edges`, `frontier` as **set**, queue of **strings**, unverified = `confidence <= 0`, `confidence_decay_rate=0.02` (default in `DepGraphBudget`).
* `propagate_beliefs`: TS = one pass `target = min(target, source*edge.confidence)` + frontier growth when ratio > `max_unverified_edge_ratio`. Python = queue-driven, `>0.05` change threshold, 100-iteration safety cap. Different algorithm.
* `DepGraphBudget.apply_decay`: TS decays then recomputes ratio; Python also pushes edges hitting 0 to the frontier.
* `refresh_policy` field exists in TS `DepGraphBudget`, not Python.
* `Belief`: TS `confidence` is 0–1, `reliability` string, `pending_sweep`, `applied_contradiction_ids: string[]`. Python `applied_contradiction_ids` is a **set** attached dynamically (not in `to_dict`, so idempotency is lost across serialisation).
* `Belief.recorded_at` TS = ISO string, Py = `datetime`. `Evidence.freshness` TS = ISO string, Py = `float` (+ separate `recorded_at`).
* `WorldModel.add_belief`: TS **throws** when `derived_from` empty; verify Python enforces the same (Python `add_belief` at `world_model.py:139`).
* `EnvironmentChange`: TS `{id, description, affected_paths[], timestamp}`; Python uses free dicts with `affected_source` (single string) and `recorded_at`/`timestamp`.
* `update_world_model` (TS) writes `OBSERVATION/SYSTEM_ERROR` → observation + `completeness_flags[region]=!prune`, `INFERENCE` → belief (confidence from reliability 1.0/0.5/0.0), recomputes belief health, bumps generation. Python `integrate_evidence` only adds observations ≥ a reliability threshold; **never** builds beliefs, no completeness flags, no health recompute inside, separate `bump_generation`.
* `staleness_sweep`: TS TTL 30 min + env-change check using `affected_paths`; verify Python (`staleness.py`, `_DEFAULT_BELIEF_TTL=30min`) reads `affected_source` instead.

## 3. Risk / VOI [B]

* `estimate_risk`: TS = `estimateRisk(action, taskGraph, worldModel)` where `module_type` `infrastructure→HIGH` (always, sets `reduce_edit_size`,`increase_verification`), `test→LOW`, else composite `0.3*fileCentrality + 0.4*changeScope + 0.3*0.5`, HIGH ≥0.5, MEDIUM ≥0.3. `changeScope` from `lines_affected/500` and `functions_affected/20`. Python = `0.4*centrality + 0.3*scope + 0.3*moduleScore`, HIGH ≥0.7, MEDIUM ≥0.4, all three inputs derived from **file path/description text** (regex, `/50` normalisation); mutates `task.risk_level`; no metadata flags.
* VOI: TS `estimateVOI()` = `((n_active-1)/n_active) * (1 - verification.strength)`, `should_gather = voi>0.5 || adequacy<0.3`, `adequacy_unresolvable`, writes back `verification_health.strength`. Python `estimate_value_of_information` = `(1 - explanation_coverage) * risk impact map {0.3,0.6,1.0}`, threshold **0.3**. Python's `verification_adequacy_critic` (9 layers / `MIN_ADEQUATE_LAYERS=3` / `MIN_RESOLVABLE_LAYERS=2`) has no TS equivalent; TS uses tool-availability ratio instead.

## 4. Hypotheses [B]

* TS `HypothesisSet` = `{active, eliminated, elimination_policy{conditions, retention_k=10, floor=0.05}}`, `eliminate()` keeps last `retention_k`. Python = `hypotheses[]` + `EliminationRecord` list + `diversity_score` on set; `EliminationPolicy{posterior_floor, diversity_threshold…}`.
* Generation: TS `generateUpdateHypotheses` = 4 fixed seeds/pass (`symp_*` 0.4, `counter_*` 0.35, `fml_*` conf, `analogy_*` 0.25), loop until diversity ≥0.7 or 10 passes, prune >10 → keep 5 into `memory_state.compression_risk.pruned_regions`. Python = separate `symptom_inference` (Jaccard>0.2, conf 0.5), `counterfactual_reasoning` (beliefs ≥0.6, conf 0.3), `analogy_based_generation` (0.4), dedupe Jaccard>0.8, `enforce_diversity`. Different seeds, confidences, IDs, loop bound and pruning.
* TS `separating_check` field on Hypothesis (semantic hypotheses) – check Python `semantic_hypotheses.py` maps to it.

## 5. Contradictions [B]

* TS `detectContradictions` **applies the resolution policy** to every detected contradiction and pushes it. Python `detect_contradictions` only `add_contradiction`s and returns the list. Callers must apply the policy separately.
* Lexical gate on pairwise/set-level detection: **RESOLVED on this branch** (both sides gate via `negation-pairs`).
* TS contradictions carry `description` (`Pairwise contradiction between "a" and "b"`, `Set-level…`, `Temporal…`, `Abstraction…`); Python's detectors leave it empty (only external ones set it). Reviewer lens (TS) prints that description in findings.
* Temporal: TS reads `change.affected_paths[]`; Python reads `change["affected_source"]` (single).
* `resolve_high`: TS marks applied + adds to `invalidation_frontier` only; Python additionally **BLOCKs task_graph dict tasks** (`high_contradiction`). TS `resolve_medium` queues `{source,target}` objects, Python queues ids.
* Abstraction context: TS `AbstractionContext.abstraction_level`, Python takes a dict `task_graph`.
* `applied_contradiction_ids` persistence (see §2).

## 6. Caller state / updates / constraint propagation [B]

* `update_success_criteria` / `revalidate_task_graph` tokenise with `split(/\s+/)` in TS vs `.split()` in Python (differs for leading/trailing whitespace: TS yields `""` tokens).
* TS `CallerState.updateConstraints` also handles `add_constraint` and `add_success_criteria`; Python `inject_clarification` does not.
* TS `checkCallerUpdates` is async, polls `CallerUpdate{pending_update, constraints_changed}`, supports `cancel_current` → `cancelTaskGraph`, returns `RESTART_ITERATION`|`NO_UPDATE`; only propagates when a `ctx` is passed. Python `check_external_updates` is sync, uses `PendingUpdate{update_type,payload}` (+ Postgres LISTEN channel), always propagates, **injects a `User clarification:` observation** (TS does not), and bumps generation itself.
* `apply_constraint_change_propagation`: TS dedupes contradictions by id after `detectContradictions` (which already applied policy) and does `worldModel.generation_id++` + `resetConstraintsChanged()`; Python only appends non-duplicate contradictions (no policy application, caller bumps generation).
* `CallerState.last_update`: TS ISO string default `now`; Python `datetime|None`.
* `OutputContract`: TS field `format: string` (default `'text'`); Python `format_requirements: dict`.

## 7. Task graph [B][S]

* Status set: TS `PENDING/RUNNING/COMPLETE/FAILED/BLOCKED/HUMAN_REQUIRED`; Python `PENDING/ACTIVE/VERIFYING/COMPLETE/FAILED/BLOCKED`. Python enforces a transition table; TS only forbids leaving `COMPLETE` and setting `FAILED` outside the execution layer (`fromExecutionLayer`).
* TS `Task` has `node_kind`, `goal_id`, `hypothesis_ids`, `relation_to_siblings`, default `risk_level` required; Python has `completed_evidence` and defaults `risk_level="LOW"`, `abstraction_level=0`.
* Conflict probability: TS keeps a plain `conflict_probability_cache` **inside `TaskGraph`**, seeded by `updateTaskGraph` (`(cA+cB)/(2*N)`, same-domain `cA/N`), reduced ×0.9 at reconcile. Python has a separate `ConflictProbabilityCache` class with Bayesian blending (`N_prior=5`), `record_actual_overlap`, `update_from_experience_store`; different formulas.
* `selectTask` (TS: returns `{task, concurrentTask, escalate}`, `PESSIMISTIC_THRESHOLD=0.5`, escalates on `HUMAN_REQUIRED`) has no Python equivalent (Python has `select_unblocked_leaf` only).
* TS `updateTaskGraph` raises `GraphCycleError`; Python `validate_task_graph` returns error strings (orphans, cycle, complete-with-incomplete-dep). TS validate (in `initialize.ts`/`rollback-replan.ts`) only checks orphaned deps.
* `applyTaskOutcome`: Python also stamps `completed_evidence`; TS doesn't.

## 8. Parallel merge [B]

* TS `mergeWorldModels(wm1, wm2)`: last-writer-wins by id for beliefs/obs/contradictions, `completeness_flags` merged, **does not** merge `environment_change_log` or `stale_flags`. Python merges N models, keeps **higher-confidence** belief, does **not** dedupe contradictions, sorts/merges `environment_change_log`, drops `completeness_flags`.
* `reconcile`: TS takes an injected resolver, sets `controlState.generation_id`, decays conflict probability ×0.9 for supplied domain pairs. Python calls `resolve_control_state(..., failure_diagnostics=None)` and records overlap observations (`da == db`).

## 9. Review gate / policy gates [B]

* World-model consistency: TS uses **`belief.confidence >= 0.8`**; Python uses `belief.reliability == "HIGH"`.
* Hypothesis compatibility: TS iterates `hypothesisSet.active[].predicted_observations`; Python iterates `hypotheses[]` and skips `eliminated`.
* Output-contract precheck: TS checks removal of `required_sections`; Python checks `required_interface_fields` (same root cause as the known `output_contract_partial` verify discrepancy).
* Code quality: TS reads `evidenceStore.tool_availability_manifest`; Python calls `tool_manifest.check_tool_availability`.
* `review_proposed_change`: **RESOLVED on this branch** (TS now evaluates all 5 and collects failures).
* Not in Python: `diagnoseReviewFailureOptions`/`REVIEW_DIMENSION_FIXES` mapping exists in `ask_question.py` – verify texts match TS.
* `review-negation` lexical gate: **RESOLVED** (now in both).
* Gates: TS `actionGate/postExecGate` take positional args + optional resolver; Python is keyword-only and adds `decomposition_gate`. `contractShadowCheck` inspects `required_sections` (TS) vs `required_interface_fields`/`interface_constraints` (Python). **Known/tracked**.

## 10. Execute [B]

* TS `execute` is async, tool receives context, supports `HarnessPauseSignal`, "continuable" outcomes (`__harnessExecutionStatus: continue|complete|failed`), returns `status`. Python is sync, no status/pause.
* Reversibility: TS = `read-only→ephemeral`, `schema|infra→snapshot`, else `patch-rollback` (no risk/git dependence). Python: `patch-rollback` only when risk LOW, else `git-revert` if a `.git` exists else `snapshot`.
* TS records a rollback point in `memory_state.rollback_points` (with serialised world model for `snapshot`). Python only generates an id.
* TS marks failure via `applyTaskOutcome(FAILED, fromExecutionLayer)`; Python moves `PENDING→ACTIVE→VERIFYING/FAILED`.
* Error symptom map: TS uses `/\b5\d{2}\b/` (any 5xx) and `/non-?zero exit/`; Python only lists 500/502/503/504 and `non-zero`/`nonzero`.
* Evidence written: TS pushes `Evidence` to `evidenceStore.observations`; Python `evidence_store.append` (`entries`). TS pushes an `environment_change_log` entry `{id,description,affected_paths:[],timestamp}` even on failure/pause; Python only on success with `{task_id,strategy,rollback_ref,timestamp,status}`.
* TS calls `planToolWorkflow()` when `unverified_edge_ratio > 0.5`; not in Python.

## 11. Verify [known]
* `output_contract_partial` (tracked, §9). Otherwise conformance-tested on statuses only.

## 12. Recovery / stall / replan [B][S]

* Stall constants are hard-coded in TS (`STALL_WINDOW=5, MAX_SWITCHES=3, RECURRENCE_THRESHOLD=3, OSCILLATION_WINDOW=6`); Python reads env overrides (`STALL_WINDOW` etc.). Behavioural drift risk.
* `cannot_make_progress(strategy, failure, task_graph)` (Py) vs `(strategy, failure)` (TS). TS treats empty `failure_class` as non-recurring; Python doesn't.
* Failure history entry: TS `FailureRecord{id,timestamp,failure_class,description,context}`; Python `FailureEntry{failure_class, step, description}`.
* Strategy selection: TS `buildStrategyOrdering` = softmax over `strategy_weights["<strategy>:<class>"]` (Python weights are nested `class → strategy`, computed from rates in a SQL-backed store). TS also supports supervisor `REDIRECT_STRATEGY`, `REFRAME_PLAN`, failure-mode bias (confidence ≥0.7 with `strategy_affinity`), `failureModeSwitch`, `requeueLeafOnLocal`, and records `switch_triggers` strings (`task_failed: <id>`, `failure_mode:X -> Y`, `supervisor:…`). Python `switch_strategy` sets `recovery_was_used`, `last_failure_class` (TS doesn't in `rollbackAndReplan`) and has none of those triggers.
* `RecoveryBudget` (Python: 20 calls / 2.0 cost / 300 s / 3 plan revisions) vs generic `Budget` (TS: all infinity by default). TS has no plan-revision counter.
* `rebuildTaskGraph`: TS ids `rebuilt-task-*`/`belief-verify-*`, `abstraction_level` 1 and 2; Python uses uuid ids, level 0; TS always adds belief tasks (`slice(0,5)`), Python skips empty statements.
* `diagnoseAndReplan`: TS resets dependents to PENDING for `status !== COMPLETE` only; Python resets **any** dependent (even COMPLETE) and clears `block_reason`.
* `assess_replan_scope` (Python, contradiction-scope driven) has no TS equivalent; TS decides scope from `noProgress`/reframe.
* `classifyRecovery` + generated table: match.

## 13. Memory / compression [B]

* `token_budget`: TS `{total: 200000, used}` object with `used/total ≥ 0.9` pressure. Python `token_budget: int = 100_000` and pressure = estimated character length of world model `> 0.9 * budget`.
* Compression policy: TS trims `compressed_structures` to 10, marks non-preserved pruned regions; Python drops observations not referenced by any belief `derived_from` and truncates beliefs >10 to last 5 (mutates the world model). TS never mutates beliefs/observations.
* `MemoryState` TS also has `rollback_points`, `journal` typed `JournalEntry{step, action_class, outcome, success, verbatim?}`, `journal_retention_policy` object; Python journal = list of dicts with `outcome=="fail"`, retention in a separate function; retained order differs (TS: failures, compressed-older, recent; Python: failures, verbatim, compressed-older; compressed shape differs).
* TS `action_dep_overlap(domains): boolean` on the state; Python `action_dep_overlap(action, memory) -> list[str]`.
* Max-steps handling: TS `0.8*maxSteps` warn / `>= maxSteps` escalate inside runtime (and `> maxSteps` in the loop body); Python `check_max_steps` reduces `verification_health.feasibility` by 0.1 on warn.

## 14. Experience store / warm start [B][M]

* TS `ExperienceStore` interface + `InMemoryExperienceStore`/`UnavailableExperienceStore` (weights, class priors, decompositions, tool workflows, verification plans, recovery sequences, `schemaVersion`). Python `ExperienceStore` is DB-backed (`append`, `query_by_type`, promotion of pending entries, offline eval pipeline, `StrategyWeightSample` rates). Different data model and API.
* `warm_start`: TS adds weights per strategy, copies class priors into the failure library, shrinks `depGraphBudget.confidence_decay_rate` (min 0.01, `1 - min(0.5, totalWeight/100)`), sets `recovery_strategy_order` via softmax(T=1). Python uses `task_class`, decomposition/failure-pattern entries, different decay rule.
* TS learning is an EMA (`rate 0.3`, prior 0.5, rounding to 4 dp). Python has no EMA/`learn_from_journal`; it upserts empirical rates.

## 15. Reviewer pass [B]

Completely different design.
* TS `reviewerPass` (async) returns string findings per lens + `pending_verdict` (severity: reviewer `Unresolved HIGH/SYSTEM_BREAKING…` and adversarial `Adversarial challenge:` → HIGH, others MEDIUM), reopens tasks whose ID appears in a finding, runs `propagateBeliefs`, `generateUpdateHypotheses`, `detectContradictions`, recomputes abstraction fit, supports `semanticCriterionCoverage`/`isCheckableCriterion`, `runAdversarialLens` flag, `criterion-substring` lexical gate.
* Adversarial seeding: TS BFS ≤3 hops, proximity ≥0.5 (1.0 criterion substring / 0.6 derived_from / 0.1), cap 10 seeds. Python: `compute_causal_proximity` = `1/(dist+1)` from belief_id-match success-criteria nodes, `top_k=5`, negated-statement seeds, failure-history seeding, `_HIGH_SEVERITY_DELTA=0.1`.
* Python implementer lens checks COMPLETE tasks have observations/HIGH contradictions and criteria vs COMPLETE tasks; TS only checks criteria vs belief substring. Python reviewer lens checks contract fields/assumptions; TS checks unresolved HIGH contradictions + weak beliefs (<0.25 more than half). Python findings are typed `ReviewFinding` objects, TS strings.
* Weak-belief threshold `0.25`, adversarial `class_priors > 0.5` finding are TS-only.

## 16. Failure modes / evidence / tool reliability [B][S]

* `FailureModeLibrary.match`: TS `match(symptoms: string[])`, symptom bidirectional substring vs curated `symptoms`, `confidence = overlap / max(entry.symptoms, symptoms)`, returns `MatchResult{failure_class, confidence, matched_pattern(id), strategy_affinity}`. Python `match(world_model, hypothesis_set, task_graph)` uses `required_conditions`/`excluded_conditions` over the concatenated text, returns `matched`, `pattern_name`, `normalised_confidence`. Default entries differ: TS symptoms `circular dependency`, `tool unavailable`, `scope expanded`, `stale belief`…; Python `depends on/circular/cycle`, `system_error/unavailable/tool`, `write_domains/scope/expanded`, `stale/belief/outdated`. The `failure-exact-match` gate is now on both sides (**RESOLVED**); `class_priors` is still TS-only.
* `EvidenceStore`: TS has `tool_reliability_envelopes` and `tool_availability_manifest` inside the store, `isToolAvailable` (missing ⇒ false); Python store is just `entries`; envelopes live in a static module table (`grep→LOW`, `linter→MEDIUM`…) and availability in `ToolManifest`.
* `applyToolReliability`: TS caps **any** evidence type by `envelope.max_conclusion_reliability` and **sets `verification_health.feasibility = 1 - lowRatio`**; Python caps **INFERENCE only**, no diagnostics side effect.
* `gatherEvidence`: TS enforces tool availability before collecting (returns undefined + warning), `SYSTEM_ERROR` ⇒ HIGH, default `MEDIUM`. Python `Evidence.__post_init__` raises on SYSTEM_ERROR≠HIGH, no availability gate.

## 17. Output contract [B][S]

* `outputValidation()` (TS) has no Python twin under that name (`validate_output_contract` + `completion_check_final` exist; compare rule-by-rule: TS `validation_rules` check `"field: …"` prefixes, interface constraints exact-equality, JSON parse when format=json, caller constraints via negation tokens (`len>3`, first 4 tokens)).
* `update_output_contract` extracts `required: <field>` (TS: `.split(':')`, first token, strip quotes). Compare with `output_contract.py:77`.

## 18. Escalation / ask-question [mostly aligned, some gaps]

* Conformance-tested (49 fixtures). Gaps: no Python `handle_escalation_response`, `escalate_budget_exhausted`; `escalate` signature differs (`SurfaceBlocker` + run state + DB vs `(controlState, strategyState, reason, missingInfo, summary)`); `SurfaceBlocker.escalated_at` is `datetime` vs ISO string; TS `EscalationReason` union should be compared with Python literal set.

## 19. Small/edge divergences
* `Supervisor`: TS `supervisorEnabled(env?)`; `budget = Number(...)`/`Math.trunc` vs Python `int(...)` (truthiness `or` for `0`/`False` inputs in `_clip`). `decide_supervisor_directive` (litellm) is Python-only; TS takes an injected `decider`. TS `coerceForWiredActions` has no Python twin (currently a no-op set).
* `TrajectoryDigest`, `InvestigationRequest`: verify field-for-field (`INVESTIGATION_CAP_K=3`, `INVESTIGATION_DONE_PREFIX`, `MAX_DEPTH=1`, `MAX_CALL_BUDGET=20`, per-call timeout 15 s, `MAX_FINDING_LEN=800` match).
* IDs: TS `Math.random()`/`Date.now()` ids vs Python `uuid4`; irrelevant unless persisted keys are compared.
* `Diagnostics`/`Evidence` numeric types (`freshness`, `recorded_at`) differ; JSON shapes are **not** interchangeable in either direction for World model/Hypotheses/Task graph/Strategy/Memory/Experience (see above); the original "mirrored JSON state-shape" claim in `scripts/harness-conformance/README.md` holds only for control-state inputs.

## 20. `harness-runtime.ts` (`driveMainLoop`) vs `loop.py` (`run_one_iteration`)

**Finding:** `run_one_iteration` is not a port of `driveMainLoop`; it is an older skeleton with a different ordering and several missing nodes.
Only tests, `node_compilers` and the `harness` package call it (no adapter does), so it was left as is and a TS twin was added:
`adapter/harness/runtime.py` (`HarnessRuntime.run`, `drive_main_loop`, `initialize_harness_state`). Tests: `adapter/tests/test_harness_runtime.py`.

| Step (TS order) | `run_one_iteration` (legacy) | `HarnessRuntime` (twin) |
|---|---|---|
| budget backstop `stepsUsed > maxSteps && !nothingLeftToRun` → `budget_exhausted` (+ budget question) | `check_max_steps` after compression, no all-COMPLETE shortcut | ✅ at the top of each iteration; also re-checked at the end after a late budget-answer poll |
| `context_compression` | after external updates | ✅ first node |
| `check_caller_updates` (+ budget answers), restart → `resolveAndStamp` | first node, no restart re-resolve | ✅ |
| `detect_contradictions` (+ `contradictionChecker`) | after Sub-step B | ✅ first node of Sub-step A |
| `generate_update_hypotheses`, `update_diagnostics` | never called per iteration | ✅ |
| `incrementGenerationId` → `resolve_control_state` (consumes the reviewer verdict) | ✅ | ✅ |
| all COMPLETE → return; `update_task_graph`; `select_task` (HUMAN_REQUIRED → `cannot_make_progress`; none → stalled fallback reply) | missing | ✅ |
| `estimate_risk`, `estimate_voi`, `review_proposed_change` (+ `semanticChangeReviewer`, `review_failure` halt with fix question) | missing | ✅ |
| `action_gate` (BLOCK/ESCALATE → task PENDING, stalled → halt) | ✅ gate only, policy stub picks the action | ✅ |
| `execute` (continuable outcomes, `semanticTaskCompletion`, parallel `concurrentTask` on a forked world model) | never executes | ✅ (`continue` re-runs the task without Sub-step A, as TS `pendingProposal` continuation) |
| Sub-step B: `incrementGenerationId`, `gather_evidence` (`exec-…`/`result-…`/fact/belief-trail), `apply_tool_reliability`, `update_world_model_post_exec`, `update_diagnostics_post_exec`, `semanticFailureMatcher`, `resolve_control_state_b` | resolve_b only | ✅ |
| `verify`, `post_exec_gate`, `update_task_state` (journal entry, COMPLETE or `rollback_replan`) | verify + gate; no task state | ✅ |
| `rollback_replan`: supervisor consulted only on a stall; GATHER_EVIDENCE → `resolve_gather_evidence`; ABORT / ASK_USER halts (cap M=2); `rollback_and_replan(..., requeue_leaf_on_local)` | supervisor handling inline in the stall block *before* the gate | ✅ |
| `completion_history` / `risk_state_history` pushes; feasibility cap at 0.8·maxSteps; yield | history only partly | ✅ |
| post-loop: `reviewerPass` (adversarial lens gated), reopen → second main loop → `reviewer_pass_2`; `output_validation` (+ `semanticConstraintJudge`); `learnFromRun` | `reviewer_pass` inside the iteration, no second loop | ✅ |

New Python helpers for the runtime: `supervisor.resolve_supervisor_directive` / `coerce_for_wired_actions`, `investigation.resolve_gather_evidence` (+ `INVESTIGATION_CAP_K`, `INVESTIGATION_DONE_PREFIX`), `runtime.validate_recovery_action_dependencies`.

**Deliberate differences:** synchronous callables instead of promises; no layer-policy gating or `reportLayer` events (so `estimate_voi`'s result is computed but not used to gate reporting, and the adversarial reviewer lens runs when the graph has ≥3 tasks or any non-LOW risk task instead of the complexity signal); `EscalationHalt` propagates out of `run()` as in TS; the legacy Python-only `RecoveryBudget`, `user_clarification` observation and DB-backed `ExperienceStore` are not used by the runtime (a TS-shaped `InMemoryExperienceStore` is the default-shaped store).

## Not verified (needs a second pass)
* ~~`harness-runtime.ts` vs `loop.py` step ordering~~ → audited in §20.
* Primitives (`blend_engine`, `multi_source_reducer`, `taxonomy_classifier`, `turn_context`, `preference_extractor`), `lexical_*`, `process_*`, `script_utils`, `normalise` (entropy), `ask_question.py`, `trajectory_digest`, `investigation` details: spot-checked, look mirrored; not line-audited.
* Python-only modules with no TS twin (`plan_store`, `plan_schema`, `execution_boundary`, `provenance`, `semantic_checks`, `langfuse_tracing`, `tool_manifest`, `node_compilers`, `state_store`): decide per module whether TS should gain them or Python should drop them.
* Conformance suites were not executed (no `node_modules`); run `node scripts/harness-conformance/compare*.mjs` to confirm the tracked items are still the only red ones.
