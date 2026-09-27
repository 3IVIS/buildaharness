/**
 * Benchmark runner — arms × tasks → graded rows → per-arm aggregates.
 *
 * Deterministic given a deterministic LLM client and arm set. The `runner.test.ts` pipeline test
 * drives this with fake arms returning canned outputs; the CLI (`scripts/run-harness-benchmark.ts`)
 * drives it with the real `baselineArm` against a real model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskSpec, TaskCategory } from './corpus/schema.js'
import { gradeTask, type ArmTurnOutput, type GradedTask, type JudgeModel, type AnswerClaimCalibration } from './graders.js'
import { armHonorsInjectedFailure, type Arm, type ArmName, type MakeLlm } from './arms.js'
import { scrubSecrets } from './transcript-capture.js'

export interface BenchmarkRow {
  arm: ArmName
  taskId: string
  category: TaskCategory
  ran: boolean
  success: boolean
  hallucination: boolean
  unauthorizedEffect: boolean
  recovered: boolean | null
  latencyMs: number | null
  costUsd: number | null
  totalTokens: number | null
  /** User turns the task ran (1 for single-turn; latency/tokens are the sum). `null` for a skipped row. */
  turns: number | null
  /** Trajectory Supervisor stall-edge consults this turn — `null` if the arm didn't report it. */
  supervisorConsults: number | null
  /** The supervisor directive action(s) this turn, in order — for triaging the S7 delta. */
  supervisorDirectives: string[] | null
  failedChecks: string[]
  /** The semantic judge's verdict for this row. `INVALID_RUN` (arm errored), `INVALID_TASK` and `UNJUDGED` rows are excluded from every rate. */
  verdict?: GradedTask['verdict']
  /** The judge's reason (or why the row is invalid). */
  reason?: string
  /** True for `INVALID_RUN` / `INVALID_TASK` / `UNJUDGED` — infrastructure or task defect, not a task outcome. */
  invalid?: boolean
  /** `ArmTurnOutput.status` for a row that ran; `undefined` for a skipped row. Lets the audit
   * driver (the audit driver) tell a rate-limited run (`status === 'error'` with a
   * rate-limit `errorMessage`) apart from a genuine hard failure. */
  status?: ArmTurnOutput['status']
  /** Populated when `status === 'error'` — the underlying error text (e.g. a `claude` CLI
   * rate-limit / usage-limit message). Machine report only. */
  errorMessage?: string
  /** First ~500 chars of the reply — for triaging a grader mismatch. Machine report only. */
  replyPreview: string
  /** AnswerClaim calibration for this task; `null` unless it produced a claim status + had a mechanical check. */
  answerClaimCalibration: AnswerClaimCalibration | null
}

/**
 * AnswerClaim confusion matrix for one arm, over the tasks that produced an `answerClaimStatus`
 * AND carried a mechanical ground truth. The `verifiedWrong` cell — claim said `verified` while
 * the answer was actually wrong — is the dangerous quadrant (overconfident-and-wrong) and a Rule 6
 * gating signal: a rise in `overconfidentWrongRate` is a regression.
 */
export interface AnswerClaimConfusion {
  /** Tasks counted (produced a claim status + had a mechanical check). */
  tasks: number
  /** claim = `verified`, answer actually correct. */
  verifiedCorrect: number
  /** claim = `verified`, answer actually wrong — overconfident-and-wrong. */
  verifiedWrong: number
  /** claim ≠ `verified`, answer actually correct (under-confident, but safe). */
  unverifiedCorrect: number
  /** claim ≠ `verified`, answer actually wrong (wrong, but honestly flagged). */
  unverifiedWrong: number
  /** `verifiedWrong / tasks` — the gating signal. */
  overconfidentWrongRate: number
}

export interface CategoryStat {
  run: number
  passed: number
}

export interface ArmAggregate {
  arm: ArmName
  label: string
  tasksRun: number
  tasksSkipped: number
  /** Rows that ran but were not scored: the arm errored (`INVALID_RUN`), the task was defective, or the judge could not answer. */
  tasksInvalid?: number
  taskSuccessRate: number
  hallucinationRate: number
  unauthorizedEffectRate: number
  /** Over tasks with an injected failure only; `null` if the corpus has none. */
  recoveryRate: number | null
  meanLatencyMs: number | null
  meanCostUsd: number | null
  totalTokens: number
  /** Mean Trajectory Supervisor consults per run task (INV-22 at benchmark scale: ~0 on the healthy corpus). */
  supervisorConsultsMean: number
  /** Total Trajectory Supervisor consults across this arm's run tasks. */
  supervisorConsultsTotal: number
  byCategory: Partial<Record<TaskCategory, CategoryStat>>
  /** AnswerClaim confusion matrix; `null` if the arm ran no AnswerClaim-producing tasks with a mechanical ground truth. */
  answerClaimConfusion: AnswerClaimConfusion | null
}

export interface BenchmarkReport {
  generatedAt: string
  corpusSize: number
  judgeEnabled: boolean
  /** Resolved model id every arm ran against (Plan A1 — pinned, on the record). `null` when unknown. */
  modelId?: string | null
  /** Resolved judge model id, when a judge ran. `null` when no judge or unknown. */
  judgeModelId?: string | null
  /**
   * Task ids skipped for **every** arm because at least one arm in the run cannot honour their
   * `injectedFailure` (see `armHonorsInjectedFailure`). Empty / absent on a run where every arm
   * shares the same injection support. A non-empty list is a coverage gap, not a fairness one —
   * the comparison stays valid, it just says nothing about recovery-under-failure for those tasks.
   * Optional so pre-existing report fixtures / on-disk reports parse unchanged; `runBenchmark`
   * always sets it.
   */
  skippedForAsymmetry?: string[]
  perArm: Record<string, ArmAggregate>
  rows: BenchmarkRow[]
  /**
   * Set when `deadlineAt` cut the run short — some (arm, task) pairs were never attempted this
   * invocation. `perArm` / `rows` cover only what ran; the caller (the CLI) must not treat this as a
   * finished report — no file should be written for it. Re-running with `resume: true` and the same
   * `transcriptDir` picks up exactly where this left off.
   */
  incomplete?: boolean
}

export interface RunOptions {
  tasks: TaskSpec[]
  arms: Arm[]
  /** Per-task LLM-client factory — see arms.ts `MakeLlm`. */
  makeLlm: MakeLlm
  judge?: JudgeModel
  /** Called after each (arm, task) — for CLI progress output. */
  onProgress?: (info: { arm: ArmName; taskId: string; success: boolean; skipped: boolean; resumed?: boolean }) => void
  /**
   * Plan A1 — when set, write one `<arm>__<taskId>__seed<tag>.json` transcript file per ran row
   * into this directory (created if absent). The row must carry an `out.transcript`.
   */
  transcriptDir?: string
  /**
   * When set alongside `transcriptDir`, an (arm, task) pair whose transcript file already exists
   * there is reconstructed from that file instead of re-run — no LLM call, no judge call. For a cell
   * killed by `CELL_TIMEOUT_SEC` partway through (the audit driver's hard_fail path commits whatever
   * transcripts landed), a retry then only pays for the work that didn't finish last time. See
   * `readResumedRow` for exactly which BenchmarkRow fields survive the round-trip.
   */
  resume?: boolean
  /**
   * Epoch ms after which `runBenchmark` stops starting new (arm, task) pairs and returns with
   * `incomplete: true` instead of running to completion — a voluntary checkpoint made well before
   * `CELL_TIMEOUT_SEC` would otherwise SIGKILL the process mid-row. Only useful paired with `resume`
   * and `transcriptDir`: without them, a re-run repeats the same partial work and hits the same
   * deadline with no progress. The CLI enforces that pairing (`--deadline-sec` requires `--resume`).
   */
  deadlineAt?: number
  /** Names the transcript files when `--seeds=1` is driven externally per-seed. Default `1`. */
  seedTag?: string | number
  /** Resolved model / judge-model ids, recorded verbatim into the report. */
  modelId?: string | null
  judgeModelId?: string | null
}

/** One on-disk transcript file — `{ task, arm, seed, modelId, prompt, events, grade, metrics }`. */
function writeTranscriptFile(
  dir: string,
  seedTag: string | number,
  modelId: string | null | undefined,
  arm: Arm,
  task: TaskSpec,
  out: ArmTurnOutput,
  graded: GradedTask,
  row: BenchmarkRow,
): void {
  // Cross-cutting rule 3: a captured task must never carry the live-network `web` tool.
  if (task.tools.web && task.webPages.length === 0) throw new Error(`transcript capture refused: task ${task.id} declares the web tool without fixture webPages (live network)`)
  mkdirSync(dir, { recursive: true })
  const payload = {
    task: task.id,
    arm: arm.name,
    seed: seedTag,
    modelId: modelId ?? null,
    prompt: task.prompt,
    events: out.transcript ?? [],
    grade: {
      success: graded.success,
      hallucination: graded.hallucination,
      unauthorizedEffect: graded.unauthorizedEffect,
      recovered: graded.recovered,
      verdict: graded.verdict,
      reason: graded.reason,
      invalid: graded.invalid,
      checks: graded.checks.map((c) => ({ name: c.name, verdict: c.verdict })),
      failedChecks: row.failedChecks,
    },
    metrics: {
      latencyMs: row.latencyMs,
      costUsd: row.costUsd,
      totalTokens: row.totalTokens,
      supervisorConsults: row.supervisorConsults,
    },
    replyPreview: row.replyPreview,
  }
  const file = join(dir, `${arm.name}__${task.id}__seed${seedTag}.json`)
  // Second scrub pass over the whole serialized payload — belt-and-braces on top of the
  // per-string scrub the capture wrapper already ran.
  writeFileSync(file, scrubSecrets(JSON.stringify(payload, null, 2)))
}

function rate(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total
}

function toRow(arm: Arm, task: TaskSpec, out: ArmTurnOutput | null, graded: GradedTask | null): BenchmarkRow {
  if (out === null || graded === null) {
    return {
      arm: arm.name,
      taskId: task.id,
      category: task.category,
      ran: false,
      success: false,
      hallucination: false,
      unauthorizedEffect: false,
      recovered: null,
      latencyMs: null,
      costUsd: null,
      totalTokens: null,
      turns: null,
      supervisorConsults: null,
      supervisorDirectives: null,
      failedChecks: [],
      replyPreview: '',
      answerClaimCalibration: null,
    }
  }
  const totalTokens =
    out.inputTokens !== undefined || out.outputTokens !== undefined
      ? (out.inputTokens ?? 0) + (out.outputTokens ?? 0)
      : null
  return {
    arm: arm.name,
    taskId: task.id,
    category: task.category,
    ran: true,
    success: graded.success,
    hallucination: graded.hallucination,
    unauthorizedEffect: graded.unauthorizedEffect,
    recovered: graded.recovered,
    latencyMs: out.latencyMs,
    costUsd: out.costUsd ?? null,
    totalTokens,
    turns: out.turns ?? 1,
    supervisorConsults: out.supervisorConsults ?? null,
    supervisorDirectives: out.supervisorDirectives ?? null,
    failedChecks: graded.checks.filter((c) => c.verdict === 'fail').map((c) => c.name),
    verdict: graded.verdict,
    reason: graded.reason,
    ...(graded.invalid ? { invalid: true } : {}),
    status: out.status,
    ...(out.errorMessage !== undefined ? { errorMessage: out.errorMessage } : {}),
    replyPreview: out.reply.slice(0, 500),
    answerClaimCalibration: graded.answerClaimCalibration,
  }
}

export function aggregate(arm: Pick<Arm, 'name' | 'label'>, rows: BenchmarkRow[]): ArmAggregate {
  // Invalid rows (errored arm / defective task / judge could not answer) are not task outcomes:
  // excluded from every rate and counted separately so an infrastructure failure can never read as a regression.
  const ran = rows.filter((r) => r.ran && !r.invalid)
  const injected = ran.filter((r) => r.recovered !== null)
  const withLatency = ran.filter((r) => r.latencyMs !== null)
  const withCost = ran.filter((r) => r.costUsd !== null)

  const byCategory: Partial<Record<TaskCategory, CategoryStat>> = {}
  for (const r of ran) {
    const s = (byCategory[r.category] ??= { run: 0, passed: 0 })
    s.run++
    if (r.success) s.passed++
  }

  const calib = ran
    .map((r) => r.answerClaimCalibration)
    .filter((c): c is NonNullable<typeof c> => c !== null)
  const verifiedWrong = calib.filter((c) => c.claimVerified && !c.answerCorrect).length
  const answerClaimConfusion: AnswerClaimConfusion | null =
    calib.length === 0
      ? null
      : {
          tasks: calib.length,
          verifiedCorrect: calib.filter((c) => c.claimVerified && c.answerCorrect).length,
          verifiedWrong,
          unverifiedCorrect: calib.filter((c) => !c.claimVerified && c.answerCorrect).length,
          unverifiedWrong: calib.filter((c) => !c.claimVerified && !c.answerCorrect).length,
          overconfidentWrongRate: rate(verifiedWrong, calib.length),
        }

  return {
    arm: arm.name,
    label: arm.label,
    tasksRun: ran.length,
    tasksSkipped: rows.filter((r) => !r.ran).length,
    tasksInvalid: rows.filter((r) => r.ran && r.invalid).length,
    taskSuccessRate: rate(ran.filter((r) => r.success).length, ran.length),
    hallucinationRate: rate(ran.filter((r) => r.hallucination).length, ran.length),
    unauthorizedEffectRate: rate(ran.filter((r) => r.unauthorizedEffect).length, ran.length),
    recoveryRate: injected.length === 0 ? null : rate(injected.filter((r) => r.recovered === true).length, injected.length),
    meanLatencyMs:
      withLatency.length === 0 ? null : Math.round(withLatency.reduce((a, r) => a + (r.latencyMs as number), 0) / withLatency.length),
    meanCostUsd:
      withCost.length === 0 ? null : withCost.reduce((a, r) => a + (r.costUsd as number), 0) / withCost.length,
    totalTokens: ran.reduce((a, r) => a + (r.totalTokens ?? 0), 0),
    supervisorConsultsTotal: ran.reduce((a, r) => a + (r.supervisorConsults ?? 0), 0),
    supervisorConsultsMean:
      ran.length === 0 ? 0 : ran.reduce((a, r) => a + (r.supervisorConsults ?? 0), 0) / ran.length,
    byCategory,
    answerClaimConfusion,
  }
}

/**
 * A task with an `injectedFailure` (task-level or on any followup) that at least one arm in the
 * run cannot honour → skip it for the whole run, so no arm is stress-tested while another runs
 * clean. Returns the set of task ids to skip.
 */
function asymmetricInjectedFailureTasks(tasks: TaskSpec[], arms: Arm[]): Set<string> {
  const armNames = arms.map((a) => a.name)
  const skip = new Set<string>()
  for (const task of tasks) {
    const kinds = [task.injectedFailure, ...task.followups.map((f) => f.injectedFailure)].filter(
      (k): k is NonNullable<typeof k> => k !== undefined,
    )
    if (kinds.length === 0) continue
    const everyArmHonoursEvery = kinds.every((k) => armNames.every((n) => armHonorsInjectedFailure(n, k)))
    if (!everyArmHonoursEvery) skip.add(task.id)
  }
  return skip
}

/**
 * Reconstructs a completed row from a previously-written transcript file, so `--resume` can skip
 * work that already made a real LLM call instead of redoing it. Reads only `grade` / `metrics` /
 * `replyPreview` / `events` — the fields every transcript has always carried — rather than trusting a
 * cached copy of the row itself, so a row picked up after `eval/regrade/apply.ts` has rewritten
 * `grade` in place is never stale.
 *
 * Lossy: `answerClaimCalibration`, `supervisorDirectives` and the original `errorMessage` were never
 * persisted to the transcript, so resumed rows carry `null`/`undefined` for those — a resumed run's
 * AnswerClaim confusion matrix and `overconfidentWrongRate` undercount whatever fraction of rows was
 * resumed. `turns` is approximated by counting `llm_request` events. Returns `null` (re-run the row
 * normally) when there is no file yet, or it can't be parsed as a transcript.
 */
export function readResumedRow(dir: string, arm: Pick<Arm, 'name'>, task: TaskSpec, seedTag: string | number): BenchmarkRow | null {
  const file = join(dir, `${arm.name}__${task.id}__seed${seedTag}.json`)
  if (!existsSync(file)) return null
  let payload: {
    grade?: { success: boolean; hallucination: boolean; unauthorizedEffect: boolean; recovered: boolean | null; verdict: GradedTask['verdict']; reason: string; invalid?: boolean; failedChecks: string[] }
    metrics?: { latencyMs: number | null; costUsd: number | null; totalTokens: number | null; supervisorConsults: number | null }
    replyPreview?: string
    events?: { kind?: string }[]
  }
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null // corrupt / partially-written file — safer to re-run than to trust it
  }
  if (!payload.grade || !payload.metrics) return null
  const turns = Array.isArray(payload.events) ? payload.events.filter((e) => e?.kind === 'llm_request').length || 1 : 1
  return {
    arm: arm.name as ArmName,
    taskId: task.id,
    category: task.category,
    ran: true,
    success: payload.grade.success,
    hallucination: payload.grade.hallucination,
    unauthorizedEffect: payload.grade.unauthorizedEffect,
    recovered: payload.grade.recovered,
    latencyMs: payload.metrics.latencyMs,
    costUsd: payload.metrics.costUsd,
    totalTokens: payload.metrics.totalTokens,
    turns,
    supervisorConsults: payload.metrics.supervisorConsults,
    supervisorDirectives: null,
    failedChecks: payload.grade.failedChecks,
    verdict: payload.grade.verdict,
    reason: payload.grade.reason,
    ...(payload.grade.invalid ? { invalid: true as const, status: 'error' as const } : {}),
    replyPreview: payload.replyPreview ?? '',
    answerClaimCalibration: null,
  }
}

export async function runBenchmark(opts: RunOptions): Promise<BenchmarkReport> {
  const rows: BenchmarkRow[] = []
  const perArm: Record<string, ArmAggregate> = {}
  let resumedCount = 0

  const skipForAsymmetry = asymmetricInjectedFailureTasks(opts.tasks, opts.arms)
  if (skipForAsymmetry.size > 0) {
    console.warn(
      `runner: skipping ${skipForAsymmetry.size} injected-failure task(s) not honoured by every arm ` +
        `in [${opts.arms.map((a) => a.name).join(', ')}] — kept fair rather than measured asymmetrically:\n  ` +
        [...skipForAsymmetry].join('\n  '),
    )
  }

  let incomplete = false
  armLoop: for (const arm of opts.arms) {
    const armRows: BenchmarkRow[] = []
    for (const task of opts.tasks) {
      if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
        incomplete = true
        perArm[arm.name] = aggregate(arm, armRows)
        break armLoop
      }
      if (skipForAsymmetry.has(task.id)) {
        const row = toRow(arm, task, null, null)
        armRows.push(row)
        rows.push(row)
        opts.onProgress?.({ arm: arm.name, taskId: task.id, success: false, skipped: true })
        continue
      }
      if (opts.resume && opts.transcriptDir) {
        const resumed = readResumedRow(opts.transcriptDir, arm, task, opts.seedTag ?? 1)
        if (resumed) {
          resumedCount++
          armRows.push(resumed)
          rows.push(resumed)
          opts.onProgress?.({ arm: arm.name, taskId: task.id, success: resumed.success, skipped: false, resumed: true })
          continue
        }
      }
      let out: ArmTurnOutput | null = null
      let graded: GradedTask | null = null
      try {
        out = await arm.run(task, opts.makeLlm)
        if (out !== null) graded = await gradeTask(task, out, opts.judge)
      } catch (err) {
        out = {
          reply: '',
          status: 'error',
          workspaceAfter: {},
          stagedMutation: false,
          latencyMs: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
        }
        graded = await gradeTask(task, out, opts.judge)
      }
      const row = toRow(arm, task, out, graded)
      armRows.push(row)
      rows.push(row)
      if (opts.transcriptDir && row.ran && out !== null && graded !== null) {
        writeTranscriptFile(opts.transcriptDir, opts.seedTag ?? 1, opts.modelId, arm, task, out, graded, row)
      }
      opts.onProgress?.({ arm: arm.name, taskId: task.id, success: row.success, skipped: !row.ran })
    }
    perArm[arm.name] = aggregate(arm, armRows)
    const invalid = armRows.filter((r) => r.ran && r.invalid)
    if (invalid.length > 0) {
      const byKind = invalid.reduce<Record<string, number>>((m, r) => ((m[r.verdict ?? 'INVALID'] = (m[r.verdict ?? 'INVALID'] ?? 0) + 1), m), {})
      console.warn(
        `runner: arm "${arm.name}" — ${invalid.length}/${armRows.length} row(s) NOT scored ${JSON.stringify(byKind)}; ` +
          `excluded from every rate.` +
          (invalid.length / armRows.length > 0.1 ? ' >10% invalid — this is an infrastructure failure, re-run those rows before reading any result.' : ''),
      )
    }
  }

  if (resumedCount > 0) {
    console.log(
      `runner: resumed ${resumedCount} row(s) from existing transcripts (--resume) — skipped re-running them. ` +
        `Their answerClaimCalibration is null (not persisted pre-resume), so overconfidentWrongRate undercounts this run.`,
    )
  }
  if (incomplete) {
    console.log(`runner: deadline reached — ${rows.length} row(s) done this invocation, rest left for a resumed re-run.`)
  }

  return {
    generatedAt: new Date().toISOString(),
    corpusSize: opts.tasks.length,
    judgeEnabled: opts.judge !== undefined,
    modelId: opts.modelId ?? null,
    judgeModelId: opts.judgeModelId ?? null,
    skippedForAsymmetry: [...skipForAsymmetry],
    perArm,
    rows,
    ...(incomplete ? { incomplete: true as const } : {}),
  }
}

// ── AL-6 evidence hygiene ───────────────────────────────────────────────────

/** AL-6: a run whose arm has more than this share of INVALID_RUN/UNJUDGED rows is re-run, not read. */
export const INVALID_ROW_LIMIT = 0.05

export interface InvalidRateViolation {
  arm: string
  invalid: number
  rows: number
}

/** Arms of `report` whose invalid-row share (`tasksInvalid / rows` among rows that ran) exceeds `limit`. */
export function invalidRateViolations(report: BenchmarkReport, limit: number = INVALID_ROW_LIMIT): InvalidRateViolation[] {
  const out: InvalidRateViolation[] = []
  for (const agg of Object.values(report.perArm)) {
    const rows = report.rows.filter((r) => r.arm === agg.arm && r.ran).length
    const invalid = agg.tasksInvalid ?? 0
    if (rows > 0 && invalid / rows > limit) out.push({ arm: agg.arm, invalid, rows })
  }
  return out
}

/** The AL-6 refusal message for a set of violations. */
export function invalidRateMessage(violations: InvalidRateViolation[], limit: number = INVALID_ROW_LIMIT): string {
  return (
    `AL-6: ${violations.map((v) => `arm "${v.arm}" ${v.invalid}/${v.rows} invalid`).join('; ')} — over the ${limit * 100}% limit. ` +
    `Re-run those rows before reading any result.`
  )
}

/**
 * The transcript directory a benchmark run writes to. `--transcripts=<dir>` wins; otherwise a
 * directory next to the report (`--out=<x>.json` → `<x>.transcripts`, else
 * `<reportsDir>/<stamp>.transcripts`). Returns `undefined` when `--transcripts=` was given empty —
 * an explicit attempt to opt out, which the script refuses (exit 2).
 */
export function resolveTranscriptDir(opts: { transcripts?: string; out?: string; reportsDir: string; stamp: string }): string | undefined {
  if (opts.transcripts !== undefined) return opts.transcripts.trim() === '' ? undefined : opts.transcripts
  if (opts.out) return opts.out.replace(/\.json$/i, '') + '.transcripts'
  return `${opts.reportsDir}/${opts.stamp}.transcripts`
}
