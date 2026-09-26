# Turn-signal classifier accuracy (AL5b)

Classifier model: `default (claude-cli)` · labeller: `claude-opus-5-5` · turns: 127 · bar: 85.0% per field
Owner spot check (docs/turn_signal_labels_review.md): **NOT done** (non-blocking)

| Field | Scored | Agreed | Accuracy | AL10 may use |
|---|---|---|---|---|
| needsGrounding | 126 | 110 | 87.3% | yes |
| ambiguity | 118 | 105 | 89.0% | yes |
| userPosture | 124 | 120 | 96.8% | yes |
| pushbackOnPriorTurn | 126 | 126 | 100.0% | yes |
| statesConstraint | 127 | 123 | 96.9% | yes |

## Cost floor
Classifier share of per-turn tokens: n/a (209 / 0); of latency: n/a (3159ms / 0ms).
