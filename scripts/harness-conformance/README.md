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
  but not a regression. Exit code stays 0.
- Any other mismatch: `MISMATCH (untracked!)` — a new divergence. Exit
  code 1, so this is safe to wire into CI as a regression gate later.

## What this first pass found

Five fixtures (`tier1-system-breaking`, `tier2-blocked-multi-dim`,
`tier3-coverage-gap`, `tier4-elevation-with-matched-pattern`,
`tier5-normal`) prove genuine parity across all five tiers, including a
case (`tier4-elevation-with-matched-pattern`) that specifically confirms
Python's `MatchResult.confidence` `@property` alias (returning
`normalised_confidence`) is correctly read by
`resolve_control_state()`'s `getattr(matched_pattern, "confidence", 0.0)`
— this was suspected to be a dead-code footgun before being read in full
and confirmed otherwise.

Two fixtures surface real, previously-undocumented behavioral drift in
`dep_class_gap_annotation` handling (advisory-only, per INV-07 — neither
affects `risk_state`/`block_mask`, only `notes[]` content):

- **Note formatting**: TS prefixes the note with `dep_class_gap: `;
  Python appends the raw annotation with no prefix.
- **Empty-string vs. absent**: TS treats an explicit empty-string
  annotation as "no annotation" (truthy check); Python treats it as
  present (`is not None` check) and appends an empty-string note.

Both are tracked in `known-discrepancies.json` rather than fixed here —
per T10's own scope, this task's job was building the comparison
mechanism and running it once, not resolving every discrepancy it finds.
