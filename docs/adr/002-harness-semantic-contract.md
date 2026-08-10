# ADR-002 — Harness Semantic Contract

**Status:** Accepted (Phases 1a, 1b, 2 implemented; Phases 3/4/7 extend it)
**Date:** 2026-08-10
**Source:** External architectural review — `reports/criticism00.txt` (private)
**Plan:** `plans/harness_and_assistant_architecture_remediation_plan.html` (private)

---

## Context

An external architectural review of this repo's harness (`adapter/harness/`) and personal
assistant (`packages/personal-assistant/`) found the framework's real strength — the
11-layer harness, the invariant suite, the observation/belief separation — was undercut by
several concrete gaps: no formal answer to "who is authoritative for what," a `generation_id`
counter whose correctness depends on a specific implementation lifecycle rather than a
checkable property, no execution identity for idempotent attribution of side effects, and a
`ControlState.risk_state` field overloading five distinct concepts (a probability? a
permission? a mode?) into one three-way enum.

The review's own closing proposal was a **Harness Semantic Contract** — ten guarantees a
harness should make, with adapters as "implementations of a proof obligation" rather than
ad-hoc compatibility layers. This ADR adopts that framing and records, per guarantee,
what Phase 1a of the remediation plan actually built versus what later phases still owe.

---

## The ten guarantees

| # | Guarantee | Status | Where |
|---|---|---|---|
| 1 | Every side effect has an execution identity | **Enforced for mechanical checks** | `ExecutionVersion` (`provenance.py`) + `execution_boundary.run_mechanical_check()` (Phase 1b): every subprocess invocation is attributed to an `ExecutionVersion`. Not yet the *only* execution path (`run_api.py`'s codegen `exec()` is unaffected — separate, larger effort, optional Phase 7 hardening). |
| 2 | Every action passes an authorization/policy decision | **Already held** | `ControlState.permission` is the sole authoritative gate `select_best_action()` reads (INV-06) — pre-existing architecture, now with a dedicated field instead of being folded into `risk_state`. |
| 3 | Every belief has provenance | **Extended** | `Belief.derived_from` already existed (INV-01). Phase 1a adds `Belief.contradicts`, stamped by `WorldModel.add_contradiction()`, so "B17 derived from E42/E51, contradicts B13" is queryable from the belief itself. |
| 4 | Every plan declares the world-state version it depends upon | **Types defined** | `PlanVersion.world_model_version`, pinned via `new_plan_version()`. Not yet attached to `TaskGraph`/plan objects themselves — a follow-up, not blocking this phase. |
| 5 | Every verification result identifies its evidence | **Types defined** | `VerificationVersion.execution_id` + `world_model_version`. Real attachment lands with Phase 2, when verification stops being 7/9 stub layers. |
| 6 | Every recovery consumes bounded resources | **Enforced** | `RecoveryBudget` (tool calls, cost, time, plan revisions) checked in `loop.py` before every strategy switch — exhaustion escalates through the existing surface-blocker path instead of taking another revision it can't afford. |
| 7 | Every external effect is idempotently attributable | **Enforced for mechanical checks** | `ExecutionVersion.effect_id` is the idempotency key; `run_mechanical_check()`'s `idempotency_store` returns a cached result rather than re-spawning a subprocess when the same `effect_id` is replayed — tested directly (a second call with the same `effect_id` spawns zero new subprocesses). |
| 8 | Learning cannot alter correctness within a run | **Enforced** | Every `experience_store.py` write (`append()`, `upsert_strategy_weight()`) lands `promoted=False`; every read (`query_by_type()`, `get_strategy_weights()`, and so `warm_start()`) only sees `promoted=True` rows. Only an explicit, separate `promote_entries()`/`promote_strategy_weights()` call (never auto-invoked) makes a candidate visible. Phase 0's `InMemoryExperienceStore.fromJSON()` degrade-not-throw behavior (TS side) is the same guarantee in a different form. |
| 9 | Runtime adapters cannot weaken these properties | **Deferred to Phase 7** | Requires the capability manifest / compile-time capability check. |
| 10 | Unsupported runtime semantics cause compilation failure | **Deferred to Phase 7** | Same capability-check mechanism as #9. |

Five of ten guarantees have real structural support after Phase 1a (#2 pre-existing, #1/#3/#4/#5
newly typed); the rest are explicitly deferred to the phase that actually needs them, not
silently assumed.

---

## Decision 1 — `ControlState` splits into five concepts, not one `risk_state`

### Fields affected

`ControlState.risk_state: NORMAL | CAUTIOUS | BLOCKED` (removed) → `permission`,
`execution_mode`, `escalation`, `risk_estimate`, `confidence_estimate` (added).

### Decision

| Field | Type | Meaning |
|---|---|---|
| `permission` | `ALLOW \| DENY` | The authoritative action gate — what `select_best_action()`/`action_gate()`/`decomposition_gate()` actually check. |
| `execution_mode` | `NORMAL \| CAUTIOUS \| RECOVERY` | A mode label independent of permission — an `ALLOW`ed action can still be `CAUTIOUS`, signalling the caller to behave more conservatively without being blocked. |
| `escalation` | `NONE \| HUMAN_REQUIRED \| SYSTEM_BREAKING` | A structured category, distinct from the free-text `escalation_reason` detail string (kept, unchanged). |
| `risk_estimate` | `float [0,1]` | Continuous, computed from the *operational* sub-dimension pool (verification strength/feasibility, progress rate, failure recurrence, oscillation). |
| `confidence_estimate` | `float [0,1]` | Continuous, computed from the *epistemic* sub-dimension pool (belief freshness/consistency/support, coverage). Deliberately a **disjoint** pool from `risk_estimate` — these are two distinct signals, not the same composite number surfaced under two names. |

The five-tier resolver (`resolve_control_state()`) is otherwise **behaviorally unchanged** —
same tier order, same thresholds, same `block_mask`/`detect_deadlock` logic. This is a field
split, not a decision-logic rewrite; the full existing test suite (1082 tests after this
phase's additions) passes unmodified in its assertions about *when* a tier fires, only
updated in *which field* it reads.

`risk_summary(cs) -> RiskState` reconstructs the old three-way reading for the one caller
that still needs it structurally: `strategy_state.risk_state_history`'s oscillation-detection
proxy in `progress.py`, which predates this split and is out of this phase's scope to rework.

### Rationale

The review's objection was specific: "10 uncertain measurements → normalization → weighted
resolver → NORMAL/CAUTIOUS/BLOCKED creates a false sense of precision... what does CAUTIOUS
mean? A probability? A permission? A mode?" Splitting into named, independently-typed fields
answers that question structurally instead of leaving it to be inferred from call-site usage.

---

## Decision 2 — `generation_id` stays a plain `int`; versioning is additive

### Decision

`WorldModel.generation_id` is **not** replaced with a rich version object. It remains the
same monotonically-increasing `int`, incremented the same way (`increment_generation_id()`,
still called twice per main-loop iteration in `loop.py` — that mechanical fact didn't change,
only the *invariant test's* assertion about it did, see Decision 3).

Instead, `provenance.py` adds three new, purely additive dataclasses — `PlanVersion`,
`ExecutionVersion`, `VerificationVersion` — each *pinning* the `world_model.generation_id`
current when it was created, via a `world_model_version` field and a `generation_id` property
alias. That alias means `staleness_check()`/`is_stale()` (staleness.py) work against any of
them exactly as they already worked against `ControlState`, with zero changes to the
staleness predicate itself.

### Rationale

Changing `WorldModel.generation_id`'s underlying type would have touched Postgres
serialization (`state_store.py`), three `staleness.py` functions doing direct integer
arithmetic, and every one of the ~7 files reading `ControlState.generation_id` — real blast
radius for no behavioral gain, since the actual ask ("Plan P7 requires WorldModel W12,
Execution E9 executed Plan P7, Verification V4 verified Execution E9" — the review's own
example) is fully satisfied by typed objects that *reference* a generation_id, not by
changing what a generation_id *is*.

---

## Decision 3 — INV-03 is replaced, not extended

### Decision

The original INV-03 ("`generation_id` increments exactly twice per loop iteration") is
replaced with two invariants matching the behavioral contract that actually matters:

1. **Monotonicity** — `world_model.generation_id` never decreases within a run.
2. **Staleness correctness** — a version-pinned object (`PlanVersion`/`ExecutionVersion`/
   `VerificationVersion`/`ControlState`) is judged stale by `is_stale()` **if and only if**
   the world model's current version has advanced past the version it was pinned to — tested
   in both directions, independent of *how many* increments occurred or *when*.

See `adapter/tests/test_harness_invariants.py`'s INV-03 section for the full rationale
comment and both replacement tests.

### Rationale

"Exactly twice per iteration" is a proxy for the property that matters (staleness detection
works), coupled to one specific implementation's lifecycle (`run_one_iteration`'s two
sub-steps). The review flagged this explicitly: "when I see an invariant like 'exactly twice
per iteration,' my architectural alarm goes off... correctness depends on a particular
implementation lifecycle." The replacement asserts the actual guarantee instead of a proxy
for it, and would still hold even if a future change restructured the loop's sub-step count.

---

## Decision 4 — Minimal trusted execution boundary (Phase 1b)

### Decision

New `execution_boundary.py`, narrow by design: bounded subprocess invocation for mechanical
checks (a linter, a test runner) only. `run_mechanical_check(argv, *, execution_version, cwd,
allowed_root, ...)` validates before spawning anything — `argv[0]`'s basename against an
allowlist (never a path, never `shell=True`), every argument against a shell-metacharacter
and path-traversal pattern, and `cwd` against a realpath-resolved containment check against
`allowed_root` — then runs with a timeout, POSIX resource limits, a minimal (non-inherited)
environment, and idempotent replay keyed by `ExecutionVersion.effect_id`.

This does **not** replace `run_api.py`'s `exec(compile(code, ...))` codegen execution path —
that's a separate, larger effort, tracked as optional further hardening in Phase 7. The
critique's proposed separation — `trusted compiler → generated program → untrusted execution
boundary` — is enforced within this module's own scope, not yet across the whole harness.

### Security review findings and fixes

Run per the remediation plan's explicit requirement for a focused security review on this
file before merging (not folded into the general Phase 1b review). Two-stage process: an
initial pass identified three candidate findings, each independently re-assessed against a
false-positive filter.

1. **RLIMIT_NPROC starves the calling user's entire process count, not just the subprocess
   tree (found by the test suite itself, not the security review).** An earlier version set
   `RLIMIT_NPROC` in the `preexec_fn` alongside `RLIMIT_CPU`/`RLIMIT_AS`. On Linux,
   `RLIMIT_NPROC` caps the number of processes for the *real UID* of the calling process, not
   a count scoped to the subprocess's own tree — setting it to 32 broke every other process
   under that UID, including the test runner itself (a pyenv shim two hops down failed to
   fork with `Resource temporarily unavailable`). Removed; `RLIMIT_CPU`/`RLIMIT_AS` are
   genuinely per-process and kept. Real subprocess-tree process-count isolation needs a
   cgroup or user namespace, out of scope for a "minimal" boundary.
2. **Argument-level absolute-path confinement and a `cwd`-validation TOCTOU were raised,
   re-assessed at confidence 3/10 and 2/10 respectively, and not fixed.** The first requires
   a caller passing an untrusted absolute path — `run_mechanical_check` has no caller yet
   anywhere in the codebase, so this is a design note for Phase 2's integration, not a
   vulnerability in code as shipped. The second is a theoretical race requiring an attacker
   who already has concurrent filesystem write access to a path component inside
   `allowed_root` — at that point they have more direct attack surface than racing a symlink
   swap. Neither is dismissed; both are documented here for Phase 2 to keep in mind.
3. **`pytest`/`mypy` in the default allowlist are de facto code-execution engines via
   `conftest.py` auto-collection and `plugins =` config — re-assessed at confidence 7/10,
   fixed anyway despite sitting just below this review's normal report threshold.** Neither
   mechanism goes through argv, so none of this module's argv-level checks see it; both are
   real, well-documented (not obscure) behaviors triggered purely by files already present
   under `cwd`. Fixed by: (a) the subprocess no longer inherits the calling process's ambient
   environment by default (`_build_subprocess_env` — minimal `PATH`-only unless a caller
   explicitly supplies `env`), closing the "arbitrary code executes with the harness
   process's own environment" half of the exposure; (b) `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`
   always merged into the subprocess environment, disabling third-party plugin autoloading
   via setuptools entry points; (c) explicit documentation (`DEFAULT_ALLOWED_EXECUTABLES`'s
   own comment, and this ADR) that `conftest.py` execution itself **cannot** be suppressed by
   a flag — it's core pytest behavior — so it remains a caller obligation: Phase 2 must never
   point `cwd`/`allowed_root` at a directory whose `conftest.py`/`pytest.ini`/`pyproject.toml`
   isn't already trusted, e.g. by checking only an isolated staging copy rather than a live
   workspace that may contain LLM-generated content.

### Rationale

"Allowlist + exec() is not the same security boundary as sandboxing" was the review's own
objection to the pre-existing `run_api.py` path. Building a second, equally-informal
boundary here would have repeated the mistake at smaller scale. Running an actual (if
scoped) security review against this file — and finding a real, fixable gap in the process —
is the point of the plan's explicit requirement for one, not a formality to satisfy.

---

## Implementation checklist (Phase 1a, complete)

- [x] `provenance.py` — `WorldModelVersion` (documentation alias, not a new type),
      `PlanVersion`, `ExecutionVersion`, `VerificationVersion`, `generate_id()`,
      `new_plan_version()`, `new_execution_version()`, `new_verification_version()`
- [x] `world_model.py` — `Belief.contradicts`, stamped pairwise by `add_contradiction()`
- [x] `control_state.py` — `permission`/`execution_mode`/`escalation`/`risk_estimate`/
      `confidence_estimate` fields; `risk_summary()` legacy-view helper; tier logic otherwise
      unchanged
- [x] `staleness.py` — `is_stale()` added (same predicate as `staleness_check()`, clearer
      name for non-`ControlState` callers); docstrings generalized
- [x] Call sites updated: `loop.py`, `gates.py`, `langfuse_tracing.py`, `__init__.py` exports
      (~7 files, all inside `adapter/harness/`; confirmed none of the four codegen adapters
      reference the removed field names directly)
- [x] `test_harness_invariants.py` — INV-03 replaced per Decision 3
- [x] 6 existing test files updated (27 `risk_state` references migrated); 1 new test file
      (`test_harness_provenance.py`, 14 tests) plus additions to `test_harness_p0.py` (belief
      provenance) and `test_harness_p3.py` (estimates, `risk_summary()`) — 21 new tests total
- [x] Full suite green: 1082 tests. `ruff check`/`ruff format` clean on every file touched.

## Implementation checklist (Phase 1b, complete)

- [x] `execution_boundary.py` — `run_mechanical_check()`, `BoundaryViolation`,
      `MechanicalCheckResult`, `DEFAULT_ALLOWED_EXECUTABLES`
- [x] Argv validation (allowlist on basename only, shell-metacharacter + path-traversal
      rejection), `cwd` containment (realpath-resolved against `allowed_root`), timeout,
      `RLIMIT_CPU` (not `RLIMIT_NPROC`, not `RLIMIT_AS` — see Decision 4 and its Phase 2
      update below), idempotency via `effect_id`, output truncation
- [x] Focused security review run (two-stage: identify, then independently re-assess each
      finding) — see Decision 4 for the three findings and what was fixed vs. documented
- [x] Environment isolation added post-review: minimal non-inherited `env` by default,
      `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` always merged in
- [x] 27 tests (`test_harness_execution_boundary.py`) — adversarial (disallowed executable,
      path-as-executable, 6 shell-metacharacter variants, 3 path-traversal variants, empty
      argv, cwd-outside-root, symlink escape), positive-path (a real `ruff --version`
      invocation), timeout-as-resource-bound, idempotency (same/different `effect_id`),
      output truncation, environment isolation (4 tests added post-review)
- [x] Full suite green: 1109 tests. `ruff check`/`ruff format` clean.

**Phase 2 update to Decision 4:** while wiring `verify_syntax`/`verify_unit` to real `ruff`/
`pytest` invocations (Decision 5 below), `RLIMIT_AS` at 1 GiB — kept from the original
security review as "seemingly generous" — broke `ruff check` outright on this (22-core)
machine: `ruff`'s rayon-based thread pool spawns one worker per core, and thread-stack
allocation across that many threads exceeded the address-space cap, surfaced by
`pthread_create` as `EAGAIN` rather than a clean memory error (`ruff --version`, which
doesn't spin up the thread pool, had passed fine — masking this until a real `check` ran
under the limit). Removed; only `RLIMIT_CPU` remains, for the same class of reason
`RLIMIT_NPROC` was already removed — see the "resource limits" comment block in
`execution_boundary.py` itself, updated in place rather than left stale. A new regression
test (`test_ruff_check_actually_runs_under_resource_limits_on_a_real_file`) exercises a
real lint, not just a version probe, so a future regression here is caught the same way.

---

## Decision 5 — Verification layers become real, or honestly SKIPPED — never a fake PASS

### Decision

Of the 9 verification layers, 7 checked only whether a *tool* was available, then
unconditionally returned PASS — never inspecting anything. Each is now one of two honest
things:

- **Real, subprocess-backed checks** (`syntax` via `ruff`, `unit` via `pytest`) — using
  Phase 1b's `execution_boundary.run_mechanical_check()`, gated on a new optional
  `target_path` parameter threaded through `verify()`. No `target_path` (every existing
  caller, including `node_compilers.py`'s codegen) → honestly `SKIPPED`, never a fake
  `PASS` — this can only turn a false `PASS` into an honest `SKIPPED` for existing callers,
  never introduce a new `FAIL` that wasn't already reachable, since the new subprocess path
  is never entered without an explicit `target_path`.
- **Real, deterministic state inspection** (`consistency`) — `world_model.contradictions`
  checked directly for unresolved `HIGH`/`SYSTEM_BREAKING` entries. No subprocess needed.
- **Honestly `SKIPPED` by design** (`requirements`, `assumptions`, `goal_correctness`,
  `integration`) — each needs environmental or model-tier judgment this mechanical layer
  can't provide (`requirements`/`assumptions`: is a criterion/assumption *semantically*
  satisfied — not this layer's job; `goal_correctness`: is this the right outcome at all —
  inherently a judgment call; `integration`: no real `integration_runner` binary exists in
  `execution_boundary`'s allowlist to invoke). Only the clear-cut mechanical case (a
  criterion/assumption was stated but no result exists at all) still `FAIL`s.

`LAYER_TIER` classifies every layer as `mechanical`/`environmental`/`model` per the
critique's own hierarchy, for future callers to weight — `has_critical_failure`'s
aggregation itself (any `FAIL` among all layers) is unchanged this phase, since with only
one tier occupied by real logic today, building a full precedence system would repeat the
"false sense of precision" the critique warned about elsewhere.

`loop.py`'s Sub-step B — which had hardcoded `verification_result = {"has_critical_failure":
False}` instead of ever calling `verify()` — now calls it for real, via new optional
`success_criteria`/`assumptions`/`tool_manifest`/`task_risk`/`target_path`/`workspace_root`
parameters on `run_one_iteration()`. Every existing caller omits `tool_manifest`, which
means every layer is honestly `SKIPPED` and `has_critical_failure` stays `False` — the exact
net effect the old stub always produced, reproduced by construction, not by coincidence.

### Rationale

The review's objection was specific: "you haven't necessarily increased confidence four
times... I'd classify verification into Mechanical/Environmental/Model." Forcing every
stub layer to fake a mechanical check would have repeated the false-confidence problem at
a different layer. Being honest that several layers need infrastructure that doesn't exist
yet (a real `integration_runner`, an environmental assumption-checker, a model-based
goal-correctness judge) is the more defensible fix — `SKIPPED` costs nothing dishonestly
claimed, where a fabricated `PASS` costs exactly the trust the review flagged as missing.

### Behavior-change note

Turning stub-`PASS` into real pass/fail for `syntax`/`unit`/`consistency` changes outcomes
for any *existing* FlowSpec/flow that already supplies a `target_path`/`tool_manifest` and
benefited from the free `PASS` — a flow that was silently "passing" may now genuinely fail.
No such caller exists yet in this codebase (confirmed: `target_path`/`tool_manifest` are
new, optional, and unused by every current caller), so this is a live risk for future
integration work, not a change that affects anything running today. Flagged here so
whoever wires a real caller in (Phase 2's own `loop.py` change is itself backward-compatible
by construction, per Decision 5 above) does a differential pass against real flows first.

---

## Decision 6 — RecoveryBudget: genuine multi-dimensional bounds, additive to the existing bound

### Decision

Before this, the only bound on "how much recovery is too much" was `STRATEGY_ORDER`'s
fixed length (6) — reaching the terminal `ESCALATE` strategy already escalated, but that's
a strategy-switch count, not a resource budget. New `RecoveryBudget` (`max_tool_calls`,
`max_cost`, `max_time_seconds`, `max_plan_revisions`, each with a matching `_used` counter,
immutable — `consume()` returns a new instance) is checked in `loop.py` **before** every
`switch_strategy()` call, additive to (not replacing) the existing `STRATEGY_ORDER` bound.
An exhausted budget (any single dimension, not just plan revisions) escalates through the
same `_build_surface_blocker("budget_exhausted", ...)` path `check_max_steps()`'s
step-count exhaustion already uses, rather than inventing a parallel escalation mechanism.

### Rationale

"Recovery is where agent systems most easily become pathological... `failure → recovery →
new plan → failure → recovery...`" per the review. A single-dimension bound (plan
revisions, i.e. strategy switches) doesn't stop a recovery loop that's cheap in switches
but expensive in tool calls or wall-clock time — the multi-dimensional budget closes that
gap without touching the existing, already-correct `STRATEGY_ORDER` exhaustion path.

---

## Decision 7 — Experience store promotion boundary

### Decision

Before this, `update_experience_store()` wrote directly into the same rows `warm_start()`
read on the very next run — immediate learning, not "immutable trace → offline learning →
candidate policy → evaluation → promotion → future runs." New migration `0012` adds
`promoted boolean NOT NULL DEFAULT false` to both `experience_entries` and
`experience_strategy_weights`. Every write (`append()`, `upsert_strategy_weight()`) now
always lands/resets `promoted=false`; every read (`query_by_type()`,
`get_strategy_weights()`, and so `warm_start()`) only ever sees `promoted=true` rows. New
`ExperienceStore.promote_entries()` / `promote_all_pending_entries()` /
`promote_strategy_weights()` are the only way a candidate becomes visible — none are called
automatically by `update_experience_store()`, the main loop, or anything else in this
module; they exist for an offline evaluation job to call explicitly.

A new invariant test (`test_inv_promotion_disabled_vs_enabled_but_unpromoted_produce_
identical_mutations`, `test_harness_p8.py`) writes real candidate data (decompositions,
tool workflows, verification plans, strategy weights) into an available-but-unpromoted
store and confirms `warm_start()`'s state mutations (`strategy_state`, `task_graph`,
`dep_graph_budget`) are identical to a fully-absent store — not just "less influential,"
zero influence. (`WarmStartResult.loaded` legitimately differs — connectivity, not
behavior — and is deliberately not compared.)

### Rationale

The review's own framing: "Learning must never be on the critical correctness path... Run →
immutable trace → offline learning → candidate policy → evaluation → promotion → future
runs. Never: Run A → learn → Run B behaves differently, without a promotion boundary."
Implementing the full pipeline (offline learning, candidate evaluation) is out of scope for
this repo — those are external processes. What belongs here, and what was missing, is the
boundary itself: a structural guarantee that nothing learned is live until something
explicit says so.

---

## Implementation checklist (Phase 2, complete)

- [x] `verification.py` — 7 stub layers replaced (2 real subprocess-backed, 1 real state
      inspection, 4 honestly `SKIPPED`-by-design); `LAYER_TIER` classification added
- [x] `loop.py` — Sub-step B's hardcoded stub replaced with a real `verify()` call;
      `success_criteria`/`assumptions`/`tool_manifest`/`task_risk`/`target_path`/
      `workspace_root` added as optional `run_one_iteration()` parameters
- [x] `recovery.py` — `RecoveryBudget` added; `loop.py`'s stall-recovery block checks it
      before every `switch_strategy()` call, escalating through the existing surface-blocker
      path on exhaustion
- [x] `experience_store.py` — `promoted` column (migration `0012`) on both tables;
      `append()`/`upsert_strategy_weight()` always write/reset unpromoted;
      `query_by_type()`/`get_strategy_weights()` filter to promoted-only;
      `promote_entries()`/`promote_all_pending_entries()`/`promote_strategy_weights()` added
- [x] Second resource-limit bug found and fixed (see Decision 4's Phase 2 update):
      `RLIMIT_AS` broke `ruff check` on a 22-core machine; removed
- [x] 43 new tests: 27 (`test_harness_verification.py`) + 7 (`RecoveryBudget`,
      `test_harness_p6.py`) + 1 (resource-limit regression, `test_harness_execution_
      boundary.py`) + 8 (promotion boundary, `test_harness_p8.py`, including the new
      disabled-vs-unpromoted invariant); 6 existing `test_harness_p8.py` tests updated for
      the new promotion lifecycle
- [x] Full suite green: 1152 tests. `ruff check`/`ruff format` clean on every file touched.

## Consequences

- **No Postgres migration required.** `HarnessRunState` persists as JSONB
  (`migrations/versions/0009_harness_run_state.py`); only `to_dict`/`from_dict` needed
  updating.
- **Small, contained blast radius.** Confirmed during planning (not just asserted): ~7 files
  read `ControlState` fields, all inside `adapter/harness/`; zero codegen adapters touch the
  removed field names.
- **INV-03's retirement is deliberate and documented**, not an incidental invariant removal —
  flagged explicitly since `test_harness_invariants.py`'s docstring calls all ten invariants
  "a permanent CI gate."
- **Three of ten Semantic Contract guarantees remain open** after Phase 2 (down from five) —
  #4 (plan/world-model version not yet attached to `TaskGraph` itself), #9 and #10 (both
  Phase 7's capability manifest) — explicitly deferred, not claimed early.
- **The security review earned its place in the plan.** It found a real, fixable gap
  (`pytest`/`mypy`'s config-driven code execution bypassing every argv-level check) that a
  purely functional review would likely have missed, since the module's own tests all passed
  before the fix — the gap was in what the tests didn't think to check, not in broken logic.
- **`RLIMIT_NPROC` is a documented trap, not just removed code.** Left in the file as an
  explicit "don't do this" comment rather than silently dropped, since the failure mode (a
  correct-looking resource limit that breaks unrelated processes sharing the same UID) is
  non-obvious and would be easy to reintroduce without that context.
- **So is `RLIMIT_AS`, found the same way one phase later.** Both resource-limit bugs were
  caught by this codebase's own test suite exercising a *real* invocation (not a trivial
  `--version` probe) under the limit — the pattern, not just the specific fix, is worth
  keeping: a positive-path test that only checks a cheap/no-op invocation will not catch a
  resource limit that's wrong for a heavier real one.
- **Verification honesty was a strictly safe direction, confirmed not just argued.** Every
  file in the existing 1061→1152-test suite passed unmodified after the stub→real/honest-
  SKIPPED rewrite, with zero test updates required for the behavior change itself (only for
  the separately-introduced promotion boundary and `risk_state` migration) — direct evidence
  that turning a false `PASS` into an honest `SKIPPED` never flips anything that was
  previously relied upon, for any caller that exists in this codebase today.
