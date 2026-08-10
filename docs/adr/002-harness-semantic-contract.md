# ADR-002 — Harness Semantic Contract

**Status:** Accepted (Phase 1a implemented; Phases 1b/2/3/4/7 extend it)
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
| 1 | Every side effect has an execution identity | **Types defined** | `ExecutionVersion` (`execution_id`/`step_id`/`attempt_id`/`effect_id`) in `provenance.py`. Not yet threaded through real execution — that's the boundary Phase 1b builds. |
| 2 | Every action passes an authorization/policy decision | **Already held** | `ControlState.permission` is the sole authoritative gate `select_best_action()` reads (INV-06) — pre-existing architecture, now with a dedicated field instead of being folded into `risk_state`. |
| 3 | Every belief has provenance | **Extended** | `Belief.derived_from` already existed (INV-01). Phase 1a adds `Belief.contradicts`, stamped by `WorldModel.add_contradiction()`, so "B17 derived from E42/E51, contradicts B13" is queryable from the belief itself. |
| 4 | Every plan declares the world-state version it depends upon | **Types defined** | `PlanVersion.world_model_version`, pinned via `new_plan_version()`. Not yet attached to `TaskGraph`/plan objects themselves — a follow-up, not blocking this phase. |
| 5 | Every verification result identifies its evidence | **Types defined** | `VerificationVersion.execution_id` + `world_model_version`. Real attachment lands with Phase 2, when verification stops being 7/9 stub layers. |
| 6 | Every recovery consumes bounded resources | **Deferred to Phase 2** | `recovery.py` today has only softmax strategy weighting, no cap. `RecoveryBudget` is Phase 2 scope. |
| 7 | Every external effect is idempotently attributable | **Key defined, enforcement deferred** | `ExecutionVersion.effect_id` is the idempotency key (a retry shares its prior attempt's `effect_id` — see `provenance.py`'s `new_execution_version()` docstring). The actual enforcement point is Phase 1b's execution boundary. |
| 8 | Learning cannot alter correctness within a run | **Partially held (TS side)** | Phase 0's `InMemoryExperienceStore.fromJSON()` degrades to a fresh store rather than ever throwing — consistent with this guarantee, but the full "immutable trace → offline learning → promotion" boundary is Phase 2 scope on the Python side. |
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
- **Five of ten Semantic Contract guarantees remain open**, explicitly deferred to the phases
  that build the machinery they need (Phase 1b's execution boundary, Phase 2's verification
  honesty and recovery budget, Phase 7's capability manifest) rather than claimed early.
