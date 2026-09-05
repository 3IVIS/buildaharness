# Comparative harness benchmark (Plan Phase B)

> `plans/harness_consolidation_and_control_plane_plan.html` — Phase B. The thing that turns
> "759 tests" into "here is the number", and the **Rule 6** gate every behavior-changing phase
> (C, D, E) must pass before its flag defaults on.

## What this is

A fixed task corpus + a mechanical grader + a multi-arm runner. Each **task** is a prompt, a
workspace, and a boring grader (substring / regex / file-state / result-status). Each **arm** is a
different way of answering the task; the arm is the independent variable, everything else is held
fixed.

```
eval/
  corpus/
    schema.ts        the TaskSpec type + zod validator
    index.ts         loadCorpus() — reads every *.json here
    *.json           one task per file (id == filename stem)
  fixtures.ts        in-memory FsBackend + per-task tool contexts
  graders.ts         gradeTask() — deterministic, LLM-free (except an optional judge rubric)
  arms.ts            the arms (baseline + flagOn + bare implemented; langgraph declared)
  bare-arm.ts        the `bare` arm — a no-harness, no-staging ReAct loop
  runner.ts          runBenchmark() — arms × tasks → graded rows → per-arm aggregates
  report.ts          renderMarkdown() + diffReports() (Rule 6)
  reports/           machine reports from real runs (gitignored except a committed baseline)
  *.test.ts          machinery tests — run in `npm test`, no LLM
```

## Metrics

Per arm, over the tasks it actually ran:

| Metric | Meaning | Better | Gating (Rule 6) |
|---|---|---|---|
| `taskSuccessRate` | mechanical grader passed | higher | **yes** |
| `hallucinationRate` | a `hallucinationProbe` task's `notContains` tripped | lower | **yes** |
| `unauthorizedEffectRate` | a mutation ran instead of staging, or a protected file changed | lower | **yes** |
| `recoveryRate` | of the `injectedFailure` tasks, how many still passed | higher | **yes** |
| `meanLatencyMs`, `meanCostUsd` | cost of the run | lower | reported, **not** gating |

A phase that regresses a gating metric without a written accepted-reason override does not ship.

## Running it

Machinery tests (fast, no LLM, part of CI):

```
npm test --workspace=packages/personal-assistant   # includes eval/*.test.ts
```

A real run (real model via the `claude-cli` backend — no API key, see CLAUDE.md):

```
cd packages/personal-assistant
npx tsx scripts/run-harness-benchmark.ts
npx tsx scripts/run-harness-benchmark.ts --tasks=compute-multiply,mutation-delete-file
npx tsx scripts/run-harness-benchmark.ts --arms=baseline
npx tsx scripts/run-harness-benchmark.ts --gate=eval/reports/<baseline>.json   # Rule 6: exit 1 on regression
```

Writes `docs/harness_comparative_benchmark.md` (human table, newest run first) and
`eval/reports/<timestamp>.json` (machine report). The older
`docs/harness_benchmark_report.md` is a separate P11.5 *perf* micro-benchmark — untouched by this.

## Arms

| Arm | Status | What it is |
|---|---|---|
| `baseline` | **implemented** | `PersonalAssistant` as shipped — the harness runs post-hoc over the model's reply (Plan §D "flag-OFF"). |
| `flagOn` | **implemented** | The assistant with the current phase's flag on. Identical to `baseline` until Phase C/D/E ships a flag, at which point this arm sets it and the two diverge — that divergence is the Rule 6 signal. |
| `bare` | **implemented** | A minimal ReAct loop over the same `ILLMClient` + tools, but no harness: no control state, no verification, no memory, and **no staging** — a `write_file`/`run_shell_command` executes immediately. Answers "is the harness worth it vs. no harness" (criticism003 #1). See `eval/bare-arm.ts`. |
| `langgraph` | **not built** | The equivalent FlowSpec compiled to LangGraph (Python). Answers "vs. an off-the-shelf framework". A 10–15 task subset, run from `adapter/eval/`. Follow-on. |

## Outstanding (Phase B follow-on)

1. **Grow the corpus** to 40–100 tasks (currently ~12, one or two per category). Every empirically-
   found bug from a Phase C/D differential lands here as a permanent task.
2. ~~Build the `bare` arm~~ — **done** (`eval/bare-arm.ts`): a no-harness, no-staging ReAct loop
   over the same `ILLMClient` + tools. Now in `IMPLEMENTED_ARMS`, so a real
   `run-harness-benchmark.ts` run includes it by default.
3. **Build the `langgraph` arm** in `adapter/eval/` (Python) for the subset.
4. **Wire a nightly real-LLM job** into `.github/workflows/eval.yml` (mocked on push — the
   `*.test.ts` already cover that — real-LLM nightly, upload the report artifact).
5. **The judge model** — `graders.ts` has the `JudgeModel` interface; wire a `ClaudeCliLLMClient`-
   backed implementation so `grader.judge` rubrics score instead of skipping.
6. **AnswerClaim calibration** — `adv-contradiction-two-specs` already grades `answerClaimStatus`;
   add a confusion-matrix rollup (when the answer was wrong, did the claim say `verified`?) once the
   corpus has enough AnswerClaim-producing tasks.
