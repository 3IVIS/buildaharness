# Turn-signal classifier accuracy (AL5b)

**Status: not yet measured.** The 127-turn eval set (`packages/aielia/eval/turn-signals-corpus.ts`), the
label reconciliation and scoring machinery (`eval/turn-signals.ts`), the labeller
(`scripts/label-turn-signals.ts`) and the scoring mode (`eval-turn-intent.ts --signals`) are committed, but
the labels require a real model from a different, stronger family than the classifier and the scoring run
needs the real classifier, neither of which was available when this was written.

To produce the table:

1. `LABELLER_BASE_URL=… LABELLER_API_KEY=… LABELLER_MODEL=… npm run eval:label-turn-signals --workspace=packages/aielia`
   (also writes `docs/turn_signal_labels_review.md`, the 30-label owner spot check).
2. `npm run eval:turn-intent --workspace=packages/aielia -- --signals [--model=<smaller>] [--turn-tokens=N --turn-ms=N] [--spot-check-done]`
   (overwrites this file with the per-field accuracy table, the cost floor and the smaller-model verdict).

Until then: **no field is certified ≥85%**, so AL10 may not use any of the five fields in a trigger, and no
smaller-model option is shipped. Owner spot check: **NOT done**.
