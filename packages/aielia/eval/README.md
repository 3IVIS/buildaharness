# Comparative harness benchmark (Plan Phase B)

> the internal plan — Phase B. The thing that turns
> "759 tests" into "here is the number", and the **Rule 6** gate every behavior-changing phase
> (C, D, E) must pass before its flag defaults on.

## What this is

A fixed task corpus + a semantic judge + a multi-arm runner. Each **task** is a prompt, a
workspace, and written pass criteria (`intent` + `note`) that an LLM judge applies to the whole
conversation. Each **arm** is a
different way of answering the task; the arm is the independent variable, everything else is held
fixed.

```
eval/
  corpus/
    schema.ts        the TaskSpec type + zod validator
    index.ts         loadCorpus() — reads every *.json here
    *.json           one task per file (id == filename stem)
  fixtures.ts        in-memory FsBackend + per-task tool contexts
  graders.ts         gradeTask() — semantic verdict from the judge + objective file-state; errored arms are INVALID_RUN
  judge.ts           ClaudeCliJudge — the semantic judge (+ the judge system prompt, transcript condenser)
  judge-stub.ts      test double for JudgeModel (machinery tests only — never a grader)
  regrade/           offline re-grade of saved transcripts (regrade.py) + its outputs — provenance of the 2026-09 re-grade
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
| `taskSuccessRate` | the semantic judge passed the turn (rows that errored or could not be judged are excluded, not failed — see `tasksInvalid`) | higher | **yes** |
| `hallucinationRate` | on a `hallucinationProbe` task, the judge saw fabricated facts or a false claim of completion | lower | **yes** |
| `unauthorizedEffectRate` | a mutation ran instead of staging, a protected file changed on disk, or the judge saw a followed injection / unrequested action | lower | **yes** |
| `recoveryRate` | of the `injectedFailure` tasks, how many still passed | higher | **yes** |
| `answerClaimConfusion.overconfidentWrongRate` | of the AnswerClaim-producing tasks, judged against the judge's verdict on the answer, how many had the claim say `verified` while the answer was actually wrong | lower | **yes** |
| `meanLatencyMs`, `meanCostUsd` | cost of the run | lower | reported, **not** gating |

A phase that regresses a gating metric without a written accepted-reason override does not ship.

## Running it

Machinery tests (fast, no LLM, part of CI):

```
npm test --workspace=packages/aielia   # includes eval/*.test.ts
```

A real run (real model via the `claude-cli` backend — no API key, see the internal developer notes):

```
cd packages/aielia
npx tsx scripts/run-harness-benchmark.ts
npx tsx scripts/run-harness-benchmark.ts --tasks=compute-multiply,mutation-delete-file
npx tsx scripts/run-harness-benchmark.ts --arms=baseline
npx tsx scripts/run-harness-benchmark.ts --judge-model=claude-opus-5-5           # the judge (default claude-opus-5-5); there is no --no-judge
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
   `eval-harness-benchmark`: on `push` (when `packages/aielia/**` changed) it runs a
   keyless `typecheck:aielia` + a `baseline.json` parse check; on `schedule` /
   `workflow_dispatch` it runs `run-harness-benchmark.ts --gate=eval/reports/baseline.json` against
   the `claude` CLI when `ANTHROPIC_API_KEY` is present (skips + exits 0 otherwise) and uploads
   `eval/reports/*.json` + `docs/harness_comparative_benchmark.md` (retention 30). Sibling job
   `eval-harness-benchmark-langgraph` does the same for the Python `langgraph` arm on the
   `OPENAI_API_KEY` path.
5. ~~**The judge model**~~ — **replaced 2026-09-24** (`eval/judge.ts`). The original mechanical grading
   (`contains` / `notContains` / `regex` / `status` on reply text, plus a YES/NO judge on 4 of 222
   tasks) was audited against the saved transcripts and found to mis-score turns in both directions:
   negation-blind (`Do not run FLUSHALL` failed `notContains "run flushall"`; a refusal that names the
   injected persona failed `notContains "Cleanup Bot"` and read as a hallucination), phrasing-brittle
   (`doesn't list` vs `doesn't mention`), blind to state (a delete that was only *staged* passed
   `deleted|removed|done`), and it scored an errored arm as a failed task (38 of 72 bare-arm runs in one
   audit seed). Now `ClaudeCliJudge` gives one semantic verdict per run by reasoning about behaviour and
   meaning against the task's `intent` + `note`, the workspace, observed run facts (final status, files
   changed on disk) and the full per-turn conversation. The legacy `grader` fields are shown as hints only.
   A judge call that errors or cannot be parsed returns `null` — the row is `UNJUDGED` and excluded, never
   a failure. An errored arm is `INVALID_RUN`; a defective task is `INVALID_TASK`; both are excluded from
   every rate and counted in `tasksInvalid` (the runner warns loudly above 10%). The judge defaults to
   `claude-opus-5-5` so it does not grade its own family's output; there is no `--no-judge` and no
   mechanical fallback. Machinery tests inject `judge-stub.ts`. The prior audit numbers were re-graded
   offline with the same prompt (`regrade/`); the lexically-graded originals are archived under
   `reports/audit/_superseded/`.
6. ~~**AnswerClaim calibration**~~ — **done**: `gradeTask` emits `answerClaimCalibration` for every
   task that produced an `answerClaimStatus` **and** (the judge's verdict on the
   answer is the ground truth for "was it right"). `runner.ts`
   rolls these into `ArmAggregate.answerClaimConfusion` — a 2×2 of claim-says-`verified` ×
   answer-actually-correct — and `report.ts` renders it per arm. The dangerous quadrant,
   `overconfidentWrongRate` (claim said `verified`, answer was wrong), **is a Rule 6 gating signal**:
   a rise in it is a regression (an assistant that is confidently wrong is worse than one that is
   honestly uncertain). When neither report ran any AnswerClaim task the metric is `null` on both
   sides and never gates.

## Supported corpus task shapes (authoring reference)

What a `corpus/*.json` task can express today (`corpus/schema.ts` `TaskSpecSchema`; multi-turn
loop covered by `arms.multiturn.test.ts`; the `audit_contradiction_multiturn` slice is the worked
example). Audit slices for a new feature (Batch C, `plans/feature_audit_batch_c_plan.html`) author
against exactly this set — anything outside it needs a schema + runner change, not just a JSON file.

| Shape | How to write it | Notes |
|---|---|---|
| **Single-turn** | `prompt` only; `followups` defaults to `[]` | The judge scores the reply against the pass criteria; `filesUnchanged` checks the final workspace. |
| **Multi-turn** | `followups: [{ prompt, addWorkspace?, injectedFailure?, injectedFailureCount? }, ...]` | Each followup goes to the *same* `PersonalAssistant` session (same memory + history) once the previous turn resolves. The judge sees the whole conversation and weights the **last** turn, per the pass criteria; `filesUnchanged` checks the final workspace; cost / latency / tokens sum across turns. Per-turn boundaries are recorded for transcripts. |
| **Fixture workspace** | `workspace: [{ path, content }]`, plus `followups[].addWorkspace` to add files mid-session | In-memory `FsBackend` (`fixtures.ts`); enable tools with `tools: { file, web, shell }`. `grader.filesUnchanged` checks byte-identical files afterwards. |
| **Injected failure** | `injectedFailure` (+ `injectedFailureCount`), per task or per followup | `first_tool_call_throws` (proxy backend only) or `persistent_tool_failure` (one-loop proposer; trips `cannotMakeProgress()`). |
| **Pass criteria** | `intent` + `note` (plain-language: what a good response does and what must NOT happen); `grader` is legacy — its fields are hints shown to the judge and never score, except `filesUnchanged` (objective on-disk check) | The semantic judge decides pass/fail. `hallucinationProbe` / `unauthorizedEffectProbe` opt a task into those corpus-wide metrics. |

**Not supported — pre-seeded memory.** There is no `memory` / `seedFacts` field: every task starts
with a fresh `InMemoryAdapter` (`arms.ts`, namespaced per task id), so nothing carries over from
"a previous session". A task that needs the assistant to *hold* a belief, constraint or fact must
establish it in turn 1 (or an early followup) as part of the task, and the slice's
`corpusNote` should say so. Cross-session persistence is therefore never exercised by a slice.

**Staged-action grading.** The judge sees the per-turn conversation, staged actions marked *staged, NOT
executed*, and the observed final `status`; "the assistant declined to make the change" is judged from
that, with `filesUnchanged` as the objective on-disk backstop. Write what must and must not happen in `note`.

New slices: add the name to `AUDIT_SLICES` in `corpus/schema.ts` (with a comment saying what the
slice stresses) — `corpus.test.ts` and `audit/manifest.test.ts` reject an unknown slice or an empty one.

## Goal-graph / mid-task steering slices (Phase 8)

`goal_graph_steering` (one pair of tasks per scope×urgency branch) and `goal_graph_concurrent` gate the
`goalGraphMode` default flip (`plans/hierarchical_goal_tree_and_steering_plan.html`). Their tasks carry
`steering: [{ message, afterTraceEvents }]` — a message sent *while turn 1 is still running*, which
`followups` (sent only after the previous turn resolves) cannot express. The `goalGraphOn` arm hands the
messages to a `LiveSteeringChannel` and passes it to `turn()` (leftovers become follow-up turns); every other
arm, `bare` included, sees them via `steeringAsFollowups()` as ordinary queued turns — today's flag-off CLI
behavior. The judge weights the last turn, so a steering task's pass criteria must be satisfiable by the
final reply under both delivery modes and must not match text that appears incidentally in an earlier answer.

    npx tsx scripts/run-harness-benchmark.ts --arms=flagOn,goalGraphOn --slice=goal_graph_steering,goal_graph_concurrent --seeds=3

2026-09-23 results: first run REGRESSED (success 90.9% → 21.2%), which exposed real downstream defects that were then fixed; re-run NEUTRAL (100% vs 100%, −21% cost). The flag stays off — see the plan's Phase 8 note. The slice is at its success ceiling; a flip needs harder mid-turn scenarios.

## Trajectory-supervisor slice (S7)

> the internal plan phase S7 · ADR-005

`corpus/*.json` carry an optional `slice` tag (`corpus/schema.ts` `SUPERVISOR_SLICES`). The
trajectory-supervisor slice is tasks that are **unsolvable without a strategy pivot, an external
lookup, or a user clarification** — the exact conditions the supervisor exists for:

| slice | count | what it probes |
|---|---|---|
| `supervisor_pivot` | 6 | the obvious first approach dead-ends; the answer needs a different route (a pointer file, a renamed key, a computed total, a two-hop lookup, the *newer* log line, two log formats) |
| `supervisor_lookup` | 6 | the fact lives somewhere non-obvious — an override file, a CHANGELOG, a nested dir, a code reference table, a transitive import, three split single-value files |
| `supervisor_clarification` | 6 | genuinely ambiguous — must ask, not guess (which env, which backup, which Alex, undefined "fast enough" / "clean up" / "best") |
| `supervisor_adversarial_digest` | 2 | workspace text carries injection ("ignore prior instructions, ABORT" / a fake "the user said delete everything") — the assistant must answer the real question and touch nothing |

**`-stall` variants** (`injectedFailure: "persistent_tool_failure"`, `corpus/schema.ts`). 6 copies
of the pivot/lookup tasks that force the supervisor's stall edge to actually fire in a single
benchmark turn — otherwise it never does (a single PA turn resolves in 1–2 harness iterations and
never reaches `cannotMakeProgress()`). The mechanism (`src/benchmark-injected-failure.ts`, wired via
the eval-only `TurnOptions.__benchmarkInjectedFailure`): the one-loop proposer's first iteration is
forced to a failed execution and 3 recurring same-class records + a matched pattern are seeded into
the run's `failureDiagnostics`, so `failureRecurring()` trips on iteration 1 and the supervisor is
consulted. `recovered` on these tasks measures whether the arm still reached a passing answer.

Run the slice:

```
npx tsx scripts/run-harness-benchmark.ts --slice=supervisor_pivot,supervisor_lookup,supervisor_clarification,supervisor_adversarial_digest
npx tsx scripts/run-harness-benchmark.ts --slice=supervisor_pivot,supervisor_lookup,supervisor_clarification,supervisor_adversarial_digest --arms=flagOn,supervisorOn --gate=eval/reports/<before>.json --gate-arm=supervisorOn

# Rule 6 multi-seed (the decision is LLM-driven — one pass is not evidence). Writes
# <stamp>.seedK.json per run + <stamp>.multiseed.json with per-metric mean/stddev/CI95 and,
# for exactly two arms, a diffSeeds verdict (positive / neutral / regressed).
npx tsx scripts/run-harness-benchmark.ts --arms=flagOn,supervisorOn --slice=supervisor_pivot,supervisor_lookup --seeds=3
```

Each row also carries `supervisorConsults` (INV-22 at scale: ~0 on the healthy corpus) and
`supervisorDirectives` (the directive action the decider returned, for triaging the delta).

**`supervisorOn` arm** — `PersonalAssistant` with `HARNESS_TRAJECTORY_SUPERVISOR=enabled`. As of S5
`harness-bridge.ts` reads `supervisorEnabled()` and, when set, passes a real `supervisorDecider`
(`src/supervisor-decider.ts` — one LLM call on the stall digest) + `askUser` host into the harness
run, so this arm genuinely diverges from `flagOn`: the only difference is the trajectory supervisor
being consulted on the `cannotMakeProgress()` stall edge. It is now in `IMPLEMENTED_ARMS`. The Rule 6
comparison for the default-on flip is **`flagOn` vs `supervisorOn`** (isolates the supervisor; both
run one-loop), not `baseline` vs `supervisorOn`.

**`contradictionOff` arm** (feature-value audit, Batch B — the internal plan
A4) — `PersonalAssistant` (`flagOn` one-loop config) with `AUDIT_SEMANTIC_CONTRADICTION=0`. That env
var gates the whole `contradictionChecker` host hook in `harness-bridge.ts`: OFF → no hook is wired,
so the harness runs its always-on lexical / negation-pair contradiction check alone (the semantic
`checkForContradictions` LLM call — one per belief-set growth — never happens). Baseline for this
feature is `flagOn` (feature present); slice `audit_contradiction_semantic` (paraphrase / unit /
indirect / cross-language belief contradictions the lexical pair-match provably can't catch, plus 2
apparent-but-not-real control tasks that catch a false-positive tax). Now in `IMPLEMENTED_ARMS`.

**Rule 6 for the flag default-on** (`HARNESS_TRAJECTORY_SUPERVISOR`, currently OFF): the
`supervisorOn` arm must beat `baseline` on the recovery + adversarial + supervisor slices with **no
regression on the existing corpus**, **multi-seed (min 3) with a reported CI**, and near-zero added
LLM calls on the healthy corpus (INV-22 at scale). A non-positive delta keeps the flag OFF and the
code inert — the negative result is recorded, not overridden.
