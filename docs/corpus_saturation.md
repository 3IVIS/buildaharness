# Corpus saturation report

Generated 2026-09-25 by `packages/aielia/eval/regrade/saturation.ts` over 16 audit feature(s) under `eval/reports/audit/`.

A (feature, category) cell is listed when **both arms pass > 90%** (no headroom) or the candidate layer **engaged on < 30%** of runs (the corpus rarely exercises it; engagement = the candidate run differs from the control run of the same task and seed in LLM-call count, success or reply).
A null verdict on a listed cell is uninformative about the layer — this is the standing evidence for F1 of `plans/adaptive_layer_selection_plan.html`.

| Feature | Category | Control pass | Candidate pass | Engagement | Runs/arm | Why listed |
|---|---|---|---|---|---|---|
| harness-vs-bare | adv_dead_end | 100% | 100% | 100% | 11 | both arms saturated |
| harness-vs-bare | compute | 100% | 100% | 100% | 6 | both arms saturated |
| harness-vs-bare | file_read | 100% | 100% | 100% | 23 | both arms saturated |
| harness-vs-bare | lookup | 100% | 100% | 100% | 8 | both arms saturated |
| harness-vs-bare | multi_step | 100% | 100% | 100% | 16 | both arms saturated |
| harness-vs-bare | research | 100% | 100% | 100% | 6 | both arms saturated |
| one-loop | adv_dead_end | 100% | 100% | 100% | 12 | both arms saturated |
| one-loop | compute | 100% | 89% | 11% | 9 | low engagement |
| one-loop | file_read | 100% | 100% | 44% | 27 | both arms saturated |
| one-loop | lookup | 100% | 100% | 58% | 12 | both arms saturated |
| one-loop | multi_step | 96% | 96% | 92% | 24 | both arms saturated |
| one-loop | research | 100% | 100% | 100% | 9 | both arms saturated |
| llm-injection-detect | file_read | 100% | 100% | 67% | 15 | both arms saturated |
| semantic-criterion-coverage | multi_step | 96% | 96% | 92% | 24 | both arms saturated |
| decomposition-reframing | file_read | 100% | 100% | 80% | 15 | both arms saturated |
| decomposition-reframing | multi_step | 100% | 100% | 100% | 6 | both arms saturated |
| decomposition-reframing | research | 100% | 100% | 100% | 3 | both arms saturated |
| verification-layer | file_read | 96% | 100% | 96% | 24 | both arms saturated |
| reviewer-pass | adv_contradiction | 100% | 100% | 100% | 6 | both arms saturated |
| steering-live | multi_step | 96% | 96% | 96% | 24 | both arms saturated |
| next-step-options | compute | 100% | 100% | 0% | 3 | both arms saturated, low engagement |
| next-step-options | lookup | 100% | 100% | 100% | 3 | both arms saturated |
| goal-graph-threads | multi_step | 100% | 100% | 42% | 24 | both arms saturated |
