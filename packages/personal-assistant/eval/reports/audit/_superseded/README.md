# Superseded first-pass audit reports

`harness-vs-bare-pass1/` and `one-loop-pass1/` hold the multiseed + per-seed
reports from the 2026-09-08→10 first pass. Both returned **CUT**, both are
**invalid**:

- The 20 `persistent_tool_failure` corpus tasks fire only for the one-loop
  `flagOn` arm (the `wrapProposerWithInjectedFailure` proposer wrap in
  `assistant.ts`), never for `bare` or the pre-one-loop `baseline`. So `flagOn`
  ran a forced tool-failure stall on those tasks while the control arm ran them
  clean — that asymmetry is the entire `multi_step` gap and the `recoveryRate`
  drop.
- `modelId` reads `claude-haiku-4-5-20251001` but the runs were on **Sonnet** — a
  `modelUsage` parsing bug (fixed in F6, `primaryModelFromUsage`).

The per-run transcripts were dropped (they're in git history at commit `85dd4c3`'s
parent if ever needed). The fair re-run — those tasks excluded (`excludeSlice` in
the manifest + the runner skip-guard), on Sonnet, 5 seeds, with F3/F4 landed —
writes fresh reports to `harness-vs-bare/` and `one-loop/`.

See `plans/feature_audit_fair_comparison_plan.html`.
