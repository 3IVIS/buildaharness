/**
 * Benchmark runner — arms × tasks → graded rows → per-arm aggregates.
 *
 * Deterministic given a deterministic LLM client and arm set. The `runner.test.ts` pipeline test
 * drives this with fake arms returning canned outputs; the CLI (`scripts/run-harness-benchmark.ts`)
 * drives it with the real `baselineArm` against a real model.
 */
import type { TaskSpec, TaskCategory } from './corpus/schema.js'
import { gradeTask, type ArmTurnOutput, type GradedTask, type JudgeModel } from './graders.js'
import type { Arm, ArmName, MakeLlm } from './arms.js'

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
  failedChecks: string[]
  /** First ~500 chars of the reply — for triaging a grader mismatch. Machine report only. */
  replyPreview: string
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
  byCategory: Partial<Record<TaskCategory, CategoryStat>>
}

export interface BenchmarkReport {
  generatedAt: string
  corpusSize: number
  judgeEnabled: boolean
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
      failedChecks: [],
      replyPreview: '',
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
    failedChecks: graded.checks.filter((c) => c.verdict === 'fail').map((c) => c.name),
    replyPreview: out.reply.slice(0, 500),
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
    byCategory,
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
      opts.onProgress?.({ arm: arm.name, taskId: task.id, success: row.success, skipped: !row.ran })
    }
    perArm[arm.name] = aggregate(arm, armRows)
  }

  return {
    generatedAt: new Date().toISOString(),
    corpusSize: opts.tasks.length,
    judgeEnabled: opts.judge !== undefined,
    perArm,
    rows,
  }
}
