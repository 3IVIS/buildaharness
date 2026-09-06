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
| `answerClaimConfusion.overconfidentWrongRate` | of the AnswerClaim-producing tasks with a mechanical ground truth, how many had the claim say `verified` while the answer was actually wrong | lower | **yes** |
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
npx tsx scripts/run-harness-benchmark.ts --no-judge                            # skip the LLM-as-judge pass (on by default)
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
| `langgraph` | **v1** | A hand-built minimal LangGraph ReAct agent (not the compiled FlowSpec — see Outstanding item 3), run from `adapter/eval/harness_bench_langgraph.py` over a 10-task subset. Answers "vs. an off-the-shelf framework" for success/hallucination/recovery. A true FlowSpec→LangGraph compile is still open. |

## Outstanding (Phase B follow-on)

1. **Grow the corpus** to 40–100 tasks (currently ~12, one or two per category). Every empirically-
   found bug from a Phase C/D differential lands here as a permanent task.
2. ~~Build the `bare` arm~~ — **done** (`eval/bare-arm.ts`): a no-harness, no-staging ReAct loop
   over the same `ILLMClient` + tools. Now in `IMPLEMENTED_ARMS`, so a real
   `run-harness-benchmark.ts` run includes it by default.
3. ~~Build the `langgraph` arm~~ in `adapter/eval/` (Python) for the subset — **partial / v1 done**.
   `adapter/eval/harness_bench_langgraph.py` (+ `harness_bench_common.py`) runs a **hand-built
   minimal LangGraph ReAct agent** (`langgraph.prebuilt.create_react_agent` over read/write/list
   file tools against a real temp dir) over a curated 10-task subset of this same corpus, ports the
   `graders.ts` mechanical checks (`contains` / `notContains` / `regex` / file-state / `status` —
   not the LLM judge, not `answerClaimStatus`), and emits a report in the `reports/*.json` shape.
   Subset: `adv-ambiguous-vague-request`, `adv-contradiction-two-specs`, `adv-dead-end-missing-value`,
   `compute-multiply`, `file-count-todos`, `lookup-capital`, `lookup-fictitious-api`,
   `multi-step-config-flag`, `multi-step-recovery`, `research-synthesize-owners` (the two
   `unauthorizedEffectProbe` / shell tasks are excluded). **Trade-off vs. "the real compiled
   FlowSpec":** it is *not* built via `adapter/langgraph_adapter.py` — it has no staging/approval
   gate, no harness layers, no `AnswerClaim`, and runs on `OPENAI_API_KEY`/LiteLLM rather than the
   `claude-cli` backend the other arms use, so cross-arm success/hallucination/recovery rates are
   comparable but latency/cost are not. Keyless structural + grader-parity test:
   `adapter/eval/test_harness_bench_langgraph.py`. Still open: a true FlowSpec→LangGraph compile of
   the assistant's toolset.
4. ~~Wire a nightly real-LLM job~~ into `.github/workflows/eval.yml` — **done**. Job
   `eval-harness-benchmark`: on `push` (when `packages/personal-assistant/**` changed) it runs a
   keyless `typecheck:personal-assistant` + a `baseline.json` parse check; on `schedule` /
   `workflow_dispatch` it runs `run-harness-benchmark.ts --gate=eval/reports/baseline.json` against
   the `claude` CLI when `ANTHROPIC_API_KEY` is present (skips + exits 0 otherwise) and uploads
   `eval/reports/*.json` + `docs/harness_comparative_benchmark.md` (retention 30). Sibling job
   `eval-harness-benchmark-langgraph` does the same for the Python `langgraph` arm on the
   `OPENAI_API_KEY` path.
5. ~~**The judge model**~~ — **done** (`eval/judge.ts`): `ClaudeCliJudge`, a tool-free
   `ClaudeCliLLMClient`-backed `JudgeModel`. `judge(rubric, prompt, reply)` makes one deterministic
   YES/NO classification call (`buildJudgePrompt` + a strict-judge system prompt) and parses it with
   `parseYesNo` — an unparseable, ambiguous, empty, or errored response returns `false` (a judge
   that can't decide does not pass the task), never throws. `scripts/run-harness-benchmark.ts`
   passes one into `runBenchmark` **on by default** for a real run; `--no-judge` opts out. The
   machinery `*.test.ts` stay judge-less, so their `judge` checks still score `skipped`.
6. ~~**AnswerClaim calibration**~~ — **done**: `gradeTask` emits `answerClaimCalibration` for every
   task that produced an `answerClaimStatus` **and** carried a mechanical ground-truth check (any
   non-skipped check that isn't the LLM `judge` or the `answerClaim ==` check itself). `runner.ts`
   rolls these into `ArmAggregate.answerClaimConfusion` — a 2×2 of claim-says-`verified` ×
   answer-actually-correct — and `report.ts` renders it per arm. The dangerous quadrant,
   `overconfidentWrongRate` (claim said `verified`, answer was wrong), **is a Rule 6 gating signal**:
   a rise in it is a regression (an assistant that is confidently wrong is worse than one that is
   honestly uncertain). When neither report ran any AnswerClaim task the metric is `null` on both
   sides and never gates.

## Trajectory-supervisor slice (S7)

> `plans/harness_trajectory_supervisor_plan.html` phase S7 · ADR-005

`corpus/*.json` carry an optional `slice` tag (`corpus/schema.ts` `SUPERVISOR_SLICES`). The
trajectory-supervisor slice is tasks that are **unsolvable without a strategy pivot, an external
lookup, or a user clarification** — the exact conditions the supervisor exists for:

| slice | count | what it probes |
|---|---|---|
| `supervisor_pivot` | 6 | the obvious first approach dead-ends; the answer needs a different route (a pointer file, a renamed key, a computed total, a two-hop lookup, the *newer* log line, two log formats) |
| `supervisor_lookup` | 6 | the fact lives somewhere non-obvious — an override file, a CHANGELOG, a nested dir, a code reference table, a transitive import, three split single-value files |
| `supervisor_clarification` | 6 | genuinely ambiguous — must ask, not guess (which env, which backup, which Alex, undefined "fast enough" / "clean up" / "best") |
| `supervisor_adversarial_digest` | 2 | workspace text carries injection ("ignore prior instructions, ABORT" / a fake "the user said delete everything") — the assistant must answer the real question and touch nothing |

Run the slice:

```
npx tsx scripts/run-harness-benchmark.ts --slice=supervisor_pivot,supervisor_lookup,supervisor_clarification,supervisor_adversarial_digest
npx tsx scripts/run-harness-benchmark.ts --slice=supervisor_clarification --arms=baseline,supervisorOn --gate=eval/reports/<before>.json --gate-arm=supervisorOn
```

**`supervisorOn` arm** — `PersonalAssistant` with `HARNESS_TRAJECTORY_SUPERVISOR=enabled`. It is in
`ALL_ARMS` but **not `IMPLEMENTED_ARMS`**, so the default run does not include it. Reason: the S5
follow-up (wire `supervisorDecider` into `harness-bridge.ts`) has not landed, so the flag currently
has **no observable effect** from the PA path — `supervisorOn` is byte-for-byte `flagOn` until then.
Once the decider is wired, move `supervisorOnArm` into `IMPLEMENTED_ARMS` and the nightly job flips
to `--arms=baseline,supervisorOn --gate-arm=supervisorOn`.

**Rule 6 for the flag default-on** (`HARNESS_TRAJECTORY_SUPERVISOR`, currently OFF): the
`supervisorOn` arm must beat `baseline` on the recovery + adversarial + supervisor slices with **no
regression on the existing corpus**, **multi-seed (min 3) with a reported CI**, and near-zero added
LLM calls on the healthy corpus (INV-22 at scale). A non-positive delta keeps the flag OFF and the
code inert — the negative result is recorded, not overridden.
