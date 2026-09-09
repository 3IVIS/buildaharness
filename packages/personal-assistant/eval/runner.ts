/**
 * Benchmark runner — arms × tasks → graded rows → per-arm aggregates.
 *
 * Deterministic given a deterministic LLM client and arm set. The `runner.test.ts` pipeline test
 * drives this with fake arms returning canned outputs; the CLI (`scripts/run-harness-benchmark.ts`)
 * drives it with the real `baselineArm` against a real model.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskSpec, TaskCategory } from './corpus/schema.js'
import { gradeTask, type ArmTurnOutput, type GradedTask, type JudgeModel, type AnswerClaimCalibration } from './graders.js'
import type { Arm, ArmName, MakeLlm } from './arms.js'
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
  /** `ArmTurnOutput.status` for a row that ran; `undefined` for a skipped row. Lets the audit
   * driver (`~/clam/feature_audit_driver.py`) tell a rate-limited run (`status === 'error'` with a
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
  perArm: Record<string, ArmAggregate>
  rows: BenchmarkRow[]
}

export interface RunOptions {
  tasks: TaskSpec[]
  arms: Arm[]
  /** Per-task LLM-client factory — see arms.ts `MakeLlm`. */
  makeLlm: MakeLlm
  judge?: JudgeModel
  /** Called after each (arm, task) — for CLI progress output. */
  onProgress?: (info: { arm: ArmName; taskId: string; success: boolean; skipped: boolean }) => void
  /**
   * Plan A1 — when set, write one `<arm>__<taskId>__seed<tag>.json` transcript file per ran row
   * into this directory (created if absent). The row must carry an `out.transcript`.
   */
  transcriptDir?: string
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
  if (task.tools.web) throw new Error(`transcript capture refused: task ${task.id} declares the web tool`)
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
    status: out.status,
    ...(out.errorMessage !== undefined ? { errorMessage: out.errorMessage } : {}),
    replyPreview: out.reply.slice(0, 500),
    answerClaimCalibration: graded.answerClaimCalibration,
  }
}

function aggregate(arm: Arm, rows: BenchmarkRow[]): ArmAggregate {
  const ran = rows.filter((r) => r.ran)
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
    tasksSkipped: rows.length - ran.length,
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

export async function runBenchmark(opts: RunOptions): Promise<BenchmarkReport> {
  const rows: BenchmarkRow[] = []
  const perArm: Record<string, ArmAggregate> = {}

  for (const arm of opts.arms) {
    const armRows: BenchmarkRow[] = []
    for (const task of opts.tasks) {
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
  }

  return {
    generatedAt: new Date().toISOString(),
    corpusSize: opts.tasks.length,
    judgeEnabled: opts.judge !== undefined,
    modelId: opts.modelId ?? null,
    judgeModelId: opts.judgeModelId ?? null,
    perArm,
    rows,
  }
}
