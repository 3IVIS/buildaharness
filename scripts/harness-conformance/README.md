# TS/Python harness conformance runner (T10)

A narrow, standalone cross-language conformance check between
`@buildaharness/harness` (TS) and `adapter/harness/*.py` (Python) — the two
independent hand-written reimplementations of the 11-layer harness that,
per the gap-coverage review's §8, share only a mirrored JSON state-shape
convention and no shared test suite.

This first pass covers one representative node — `resolveControlState()` /
`resolve_control_state()`, the five-tier control-state resolver — rather
than attempting to conformance-test all ~30 harness node files in one go.
Extending this pattern (new fixtures + a `run-ts.mts`/`run_py.py` pair) to
another node is the natural way to grow coverage incrementally.

## Usage

```bash
node scripts/harness-conformance/compare.mjs
```

For each `fixtures/*.json`, this feeds the same input to both languages'
own implementation (via `npx tsx run-ts.mts <fixture>` and
`python3.12 run_py.py <fixture>`), serializes both outputs to the shared
`ControlState` JSON shape, and diffs them.

- A fixture whose outputs match on both sides: `PASS`.
- A fixture listed in `known-discrepancies.json`: `DISCREPANCY (tracked)` —
  a real, already-identified divergence a human still needs to resolve,
  but not a regression. Exit code stays 0. **`known-discrepancies.json` is
  currently empty (`{}`) — the two `dep_class_gap` divergences it tracked
  were resolved in Phase C1 (see below).**
- Any other mismatch: `MISMATCH (untracked!)` — a new divergence. Exit
  code 1 — this is wired into CI (`.github/workflows/ci.yml`) as a
  regression gate.

## Coverage

**Expanded to 27 fixtures (2026-09-04).** The 20 `tier2-block-*` / `tier2-boundary-*` /
`tier3-*` / `tier4-elevation-no-pattern` / `estimates-*` /
`tier1-*` fixtures added then systematically cover: every one of the 10
sub-dimensions individually below `CRITICAL_THRESHOLD`; the exact `0.2`
and `0.4` boundaries (strict `<` on both); single- and dual-coverage-gap
tier-3; tier-4 elevation with no matched pattern; the two disjoint
`risk_estimate` / `confidence_estimate` pools; a SYSTEM_BREAKING
contradiction dominating otherwise-healthy diagnostics; and a
non-SYSTEM_BREAKING contradiction correctly *not* firing tier 1.

Result (after Phase C1): **27 PASS, 0 tracked discrepancies, 0 untracked** —
the two resolvers are byte-identical across the whole boundary space, not
just the original 5 tier examples. One finding baked into a fixture:
`tier2-block-multi-no-deadlock` confirms a pure-sub-dimension deadlock is
structurally unreachable (`dep_graph_quality` / `world_model_integrity`
are not sub-dimensions, so no recovery-action cycle forms from sub-dim
blocks alone) — `escalation` stays `NONE`, matching on both sides.

Treat this fixture set as the **equivalence contract** for the resolver
algorithm: a change to either side's algorithm that is not accompanied by
fixtures proving the other side still matches should not merge. Growing it
toward ~40 (covering `verify()` next) is the natural next step.

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
