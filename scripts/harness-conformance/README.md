# TS/Python harness conformance runner (T10)

A narrow, standalone cross-language conformance check between
`@buildaharness/harness` (TS) and `adapter/harness/*.py` (Python) — the two
independent hand-written reimplementations of the 11-layer harness that,
per the gap-coverage review's §8, share only a mirrored JSON state-shape
convention and (via `spec/harness-core.json`, Phase C1) a generated set of
decision constants — but no shared algorithm and, until now, no shared
test suite.

This pass covers one representative node — `resolveControlState()` /
`resolve_control_state()`, the five-tier control-state resolver — rather
than attempting to conformance-test all ~30 harness node files in one go.
Extending this pattern (new fixtures + a `run-ts.mts`/`run_py.py` pair) to
another node is the natural way to grow coverage incrementally.

## The named equivalence contract

**RESOLVER-EQUIVALENCE CONTRACT.** The `fixtures/*.json` set in this
directory *is* the equivalence contract for the five-tier control-state
resolver. `resolve_control_state()` (`adapter/harness/control_state.py`)
and `resolveControlState()`
(`packages/harness/src/nodes/resolve-control-state.ts`) are hand-mirrored
reimplementations of the same ~150-line algorithm; the fixture set is the
executable definition of "the same".

Therefore:

1. **A change to the resolver algorithm on either side that ships without
   fixtures proving the other side still produces identical `ControlState`
   output must not merge.** A PR that edits `control_state.py`'s or
   `resolve-control-state.ts`'s tier logic, deadlock detection, estimate
   pools, or note formatting is incomplete until (a) the matching change
   lands on the other runtime, (b) `node scripts/harness-conformance/compare.mjs`
   reports every fixture `PASS` with `0 untracked`, and (c) the goldens
   (`goldens/*.json`) are regenerated in the same PR if behaviour changed
   (`node scripts/harness-conformance/gen-goldens.mjs --write`).
2. **New resolver behaviour requires a new fixture that pins it** — on
   both runtimes at once — before the behaviour is considered shipped.
3. **A genuine, intentional divergence** is recorded in
   `known-discrepancies.json` with a reason (a human still owns resolving
   it); it is *not* a licence to leave `compare.mjs` red.

This contract is enforced three ways:

- `compare.mjs` — cross-language diff, the source of truth for "TS ==
  Python" (needs both toolchains; slow). Wired into CI
  (`.github/workflows/ci.yml`, "Harness TS/Python conformance") as the
  regression gate.
- `adapter/tests/test_harness_conformance_gate.py` — **INV-13**, Python
  side: every fixture, run through `resolve_control_state()`, asserted
  equal to its golden. Fails in a plain `pytest` run; runs in CI as part
  of `adapter && pytest tests/`.
- `packages/harness/src/nodes/conformance-gate.test.ts` — **INV-13**, TS
  side: every fixture, run through `resolveControlState()`, asserted equal
  to the *same* golden. Fails in a plain `vitest` / `npm test` run in
  `packages/harness`.

Because `compare.mjs` proves TS output equals Python output for every
committed fixture, a single golden set (captured from the Python resolver)
is valid for both in-suite gates. A one-side drift then fails that side's
unit run even when the cross-language runner isn't invoked.

## Usage

```bash
node scripts/harness-conformance/compare.mjs        # cross-language diff (CI regression gate)
node scripts/harness-conformance/gen-goldens.mjs    # --check goldens are current (default)
```

For each `fixtures/*.json`, `compare.mjs` feeds the same input to both
languages' own implementation (via `npx tsx run-ts.mts <fixture>` and
`python3.12 run_py.py <fixture>`), serializes both outputs to the shared
`ControlState` JSON shape, and diffs them.

- A fixture whose outputs match on both sides: `PASS`.
- A fixture listed in `known-discrepancies.json`: `DISCREPANCY (tracked)` —
  a real, already-identified divergence a human still needs to resolve,
  but not a regression. Exit code stays 0. **`known-discrepancies.json` is
  currently empty (`{}`) — the two `dep_class_gap` divergences it tracked
  were resolved in Phase C1 (see below).**
- Any other mismatch: `MISMATCH (untracked!)` — a new divergence. Exit
  code 1 — this is the regression gate.

### Goldens and how to regenerate them

`goldens/<fixture-id>.json` holds the expected serialized `ControlState`
for each fixture — one golden per fixture, same id. They are the **Python
resolver's own output**, captured by `gen-goldens.mjs`, and are valid for
the TS gate too only because `compare.mjs` proves the two runtimes agree.

Regenerate **only** when the resolver algorithm legitimately changed and
both runtimes were updated in lockstep:

```bash
node scripts/harness-conformance/compare.mjs            # MUST be all PASS, 0 untracked
node scripts/harness-conformance/gen-goldens.mjs --write # rewrite goldens/*.json
```

A `--write` that is not backed by a green `compare.mjs` run is precisely
the one-side drift INV-13 exists to catch — don't do it to "make the
tests pass". `gen-goldens.mjs` with no flag (`--check`) fails if any
golden is stale, missing, or orphaned.

## Coverage

**53 fixtures (2026-09-05).** Grown from 27 → 53 as ADR-004 Phase C2
residual work. The set now covers:

- **Every one of the 10 sub-dimensions individually below
  `CRITICAL_THRESHOLD`** (the `tier2-block-*` fixtures at 0.15), each
  producing its own single `block_mask` entry with the dimension's
  `DIMENSION_RECOVERY` action class and no deadlock.
- **Every one of the 10 sub-dimensions at BOTH exact threshold
  boundaries** (`boundary-*` + the two pre-existing
  `tier2-boundary-exactly-critical` / `tier3-boundary-exactly-caution`):
  - at exactly `0.2` (`CRITICAL_THRESHOLD`): strict `<` means **no**
    tier-2 block; a non-coverage dim then elevates to `CAUTIOUS` via
    tier-4 (`deficit 0.2 / 0.4 = 0.5 > 0.05`), a coverage dim additionally
    emits its tier-3 `Coverage gap …` note.
  - at exactly `0.4` (`CAUTION_THRESHOLD`): strict `<` on both the tier-3
    check and `compute_elevation_factor` means **nothing** fires →
    `NORMAL`/`ALLOW`.
  - `failure_recurrence` / `oscillation_score` are covered via their
    inverted raw inputs. `boundary-*-critical-float-inversion` pins that
    `1.0 - 0.8` evaluates to `0.19999999999999996` **bit-identically on
    both runtimes** — just below `0.2`, so these two dims *do* block at
    that raw value (the strict `<` is satisfied by the rounding error).
- **Tier-4 proportional elevation with a matched failure pattern** at
  several confidences: `0.25` (elevation factor exactly `0.05`, the strict
  `> 0.05` boundary → stays `NORMAL`), and `0.3 / 0.5 / 0.7 / 0.9` (all
  elevate → `CAUTIOUS`), plus the pre-existing confidence-`1.0` case that
  also exercises Python's `MatchResult.confidence` `@property` alias.
- **Tier-3 coverage gaps**: single gap (`symptom_coverage` only /
  `explanation_coverage` only) and dual gap (both), each with the exact
  per-dimension note text.
- **The two disjoint estimate pools** (`estimates-*`): `risk_estimate`
  from `_RISK_DIMENSIONS`, `confidence_estimate` from
  `_CONFIDENCE_DIMENSIONS`, computed from non-overlapping sub-dimension
  sets.
- **Tier 1**: a `SYSTEM_BREAKING` contradiction dominating otherwise-
  healthy diagnostics; a non-`SYSTEM_BREAKING` contradiction correctly
  *not* firing tier 1.
- **`dep_class_gap_annotation`** (INV-07, advisory-only): canonical
  `dep_class_gap: <annotation>` note format, and empty-string vs. absent
  (both Phase C1 regression fixtures).

Result: **53 PASS, 0 tracked discrepancies, 0 untracked** — the two
resolvers are byte-identical across this whole boundary space.

### On deadlock cycles

`detect_deadlock` / `detectDeadlock` build a recovery-action graph from
`RECOVERY_ACTION_DEPENDENCIES` restricted to *currently-blocked*
dimensions and look for a directed cycle. **A genuine recovery-action
cycle is not reachable through the resolver's public inputs**
(`diagnostics` + `world_model` + `matched_pattern`), because tier-2 only
ever blocks the 10 named sub-dimensions and every sub-dimension's
recovery-dependency chain terminates at `dep_graph_quality` — which is not
itself a sub-dimension and so is never blocked. The only structural
2-cycle in the dependency table (`verification_strength` ⇄
`dep_graph_quality`, via `verification_pass` / `dep_graph_refresh`)
requires `dep_graph_quality` to be in the block mask, which the resolver
never does on its own.

The fixture set therefore pins this with **no-deadlock** cases at
increasing chain length:

- `tier2-block-multi-no-deadlock` — three independent sub-dim blocks, no
  edges between them.
- `tier2-no-deadlock-recovery-chain-len2` — two blocked sub-dims with a
  real recovery-dependency **edge** between them
  (`belief_consistency → verification_strength`); still open (no back
  edge) → `escalation` stays `NONE`.
- `tier2-no-deadlock-recovery-chain-len3` — a 3-hop chain
  (`belief_support → belief_freshness → verification_feasibility →` dead
  end at `dep_graph_quality`) that still does not close.

Constructing a *true* cycle would require feeding `detect_deadlock` a
hand-built `block_mask` containing non-sub-dimension entries — a lower
level than `run-ts.mts` / `run_py.py` expose. The `INV-04` tests in
`adapter/tests/test_harness_invariants.py` cover `detect_deadlock`'s
graph-level behaviour directly on the Python side.

## What the original pass found

Five fixtures (`tier1-system-breaking`, `tier2-blocked-multi-dim`,
`tier3-coverage-gap`, `tier4-elevation-with-matched-pattern`,
`tier5-normal`) prove genuine parity across all five tiers, including a
case (`tier4-elevation-with-matched-pattern`) that specifically confirms
Python's `MatchResult.confidence` `@property` alias (returning
`normalised_confidence`) is correctly read by
`resolve_control_state()`'s `getattr(matched_pattern, "confidence", 0.0)`
— this was suspected to be a dead-code footgun before being read in full
and confirmed otherwise.

Two fixtures surfaced real behavioral drift in `dep_class_gap_annotation`
handling (advisory-only, per INV-07 — neither affects
`permission`/`block_mask`, only `notes[]` content):

- **Note formatting**: TS prefixed the note with `dep_class_gap: `;
  Python appended the raw annotation with no prefix.
- **Empty-string vs. absent**: TS treated an explicit empty-string
  annotation as "no annotation" (truthy check); Python treated it as
  present (`is not None` check) and appended an empty-string note.

**Resolved in Phase C1** (maintainer decision, 2026-09-04: canonical =
prefix + truthy check — align Python to TS). The prefix now comes from one
source (`DEP_CLASS_GAP_NOTE_PREFIX` in `spec/harness-core.json`, generated
into both runtimes), and Python's `_attach_annotation` uses the same
truthy check as `resolve-control-state.ts`. `known-discrepancies.json` is
now empty; `dep-class-gap-notes-format.json` /
`dep-class-gap-empty-string.json` stay as `PASS` regression fixtures.
