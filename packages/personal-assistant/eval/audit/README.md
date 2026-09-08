# Feature Value Audit — matrix queue

> `plans/feature_value_audit.html` — the audit programme.
> `plans/feature_audit_automation_plan.html` — how this directory is built and driven.

The audit prices one reasoning feature at a time: state the hypothesis, build an arm that toggles
exactly it, stress it with a corpus slice, measure 3-seed, decide **KEEP / CUT / INCONCLUSIVE**.
This directory is the machine-readable queue plus the pure functions that pick the next unit of
work and turn a feature's seed reports into a verdict.

## Files

```
audit/
  types.ts        AuditManifest / AuditProgress zod schema + AuditCell
  select.ts       nextCell(manifest, progress) → the one unit of work for this wakeup
  aggregate.ts    auditVerdict(seedReports, control, candidate) → KEEP / CUT / INCONCLUSIVE + rationale
  manifest.json   the queue — one entry per feature (empty until plan phase A7 seeds it)
  *.test.ts       pure-function tests, run in `npm test`
  gen-audit-entry.mjs        (A2) seed reports → benchmark-md section + registry row
  gen-transcript-pages.mjs   (A2) enriched report → static HTML into the pages repo
```

Seed reports and transcripts land under `../reports/audit/<feature>/` and are **git-tracked** (an
exception to `../reports/.gitignore`) — they are the published evidence trail, not throwaway local
runs. Runtime progress is `../reports/audit/progress.json`, written by the driver, not the manifest.

## Two drivers — do not conflate

| Driver | Runs | Reads |
|---|---|---|
| `~/clam/plan_driver.py` (`plan-feature-audit-automation`) | the **build phases** A0–A8, one per wakeup, gate-checked | `plans/feature_audit_automation_plan.html` |
| `~/clam/feature_audit_driver.py` (`feature-audit-matrix`) | the **benchmark matrix**, one `(feature, seed)` cell per wakeup, after the build lands | `manifest.json` + `progress.json` |

## Manifest entry

```jsonc
{
  "id": "semantic-contradiction",           // kebab-case; also the reports/ subdir + pages slug
  "title": "Semantic contradiction check",
  "hypothesis": "The lexical negation-pair check misses enough paraphrased conflicts that the LLM call pays for itself.",
  "arms": ["contradictionOff", "flagOn"],    // [control, candidate] — candidate = feature PRESENT
  "slice": "audit_contradiction_semantic",   // corpus slice tag, or null for the full corpus
  "seeds": 3,                                 // 3 is the floor
  "fullPages": "all",                         // "all" | "adv,injected" (big full-corpus features)
  "maxSpendUsd": 5,                           // optional per-feature ceiling
  "status": "queued"                          // queued | running | done | needs_manual_review
}
```

`arms` is `[control, candidate]` and lines up with `report.ts`'s `diffSeeds(a, b)` where `b` is the
candidate: a **positive** diff means the feature-present arm beat the feature-absent arm on task
success. A cell run is one `run-harness-benchmark.ts --arms=<control>,<candidate> --slice=<slice>
--seeds=1 --transcripts=... --model=sonnet --judge-model=sonnet`.
