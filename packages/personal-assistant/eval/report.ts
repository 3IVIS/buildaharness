/**
 * Report rendering for the harness benchmark.
 *
 *  - `renderMarkdown(report)`      → the human table, appended to docs/harness_benchmark_report.md
 *  - `diffReports(before, after)`  → the machine delta the Plan's "Rule 6" gate consumes
 *
 * `diffReports` is pure and deterministic — a phase's CI step runs the benchmark before and after
 * its flag flip, calls this, and fails if `regressed` is true without an accepted-reason override.
 */
import type { BenchmarkReport, ArmAggregate } from './runner.js'

function pct(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`
}
function ms(n: number | null): string {
  return n === null ? '—' : `${n} ms`
}
function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(4)}`
}

export function renderMarkdown(report: BenchmarkReport): string {
  const arms = Object.values(report.perArm)
  const lines: string[] = []
  lines.push(`## Run ${report.generatedAt}`)
  lines.push('')
  lines.push(
    `Corpus: ${report.corpusSize} tasks. Judge model: ${report.judgeEnabled ? 'enabled' : 'disabled (judge checks scored `skipped`)'}.`,
  )
  lines.push('')
  lines.push('| Arm | Ran | Success | Hallucination | Unauth. effect | Recovery | Mean latency | Mean cost | Tokens |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const a of arms) {
    lines.push(
      `| ${a.arm} | ${a.tasksRun}${a.tasksSkipped ? ` (+${a.tasksSkipped} skipped)` : ''} | ${pct(a.taskSuccessRate)} | ${pct(a.hallucinationRate)} | ${pct(a.unauthorizedEffectRate)} | ${pct(a.recoveryRate)} | ${ms(a.meanLatencyMs)} | ${usd(a.meanCostUsd)} | ${a.totalTokens} |`,
    )
  }
  lines.push('')
  lines.push('### Per-category success')
  lines.push('')
  const cats = [...new Set(report.rows.map((r) => r.category))].sort()
  lines.push(`| Arm | ${cats.join(' | ')} |`)
  lines.push(`|---|${cats.map(() => '---').join('|')}|`)
  for (const a of arms) {
    const cells = cats.map((c) => {
      const s = a.byCategory[c]
      return s ? `${s.passed}/${s.run}` : '—'
    })
    lines.push(`| ${a.arm} | ${cells.join(' | ')} |`)
  }
  lines.push('')
  lines.push('### Failures')
  lines.push('')
  const failures = report.rows.filter((r) => r.ran && !r.success)
  if (failures.length === 0) {
    lines.push('_none_')
  } else {
    for (const f of failures) {
      lines.push(`- \`${f.arm}\` · \`${f.taskId}\` — ${f.failedChecks.join('; ') || 'no passing checks'}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

// ── Rule 6 diff ──────────────────────────────────────────────────────────────

export interface MetricDelta {
  metric: string
  before: number | null
  after: number | null
  delta: number | null
  /** True if this delta is a regression (worse outcome). */
  regression: boolean
}

export interface ReportDiff {
  arm: string
  deltas: MetricDelta[]
  /** Any regression on a gating metric. */
  regressed: boolean
  /** The gating metrics that regressed. */
  regressions: string[]
}

/**
 * Metrics where a *higher* number is better. The rest (hallucination, unauthorized effect,
 * latency, cost) are better lower.
 */
const HIGHER_IS_BETTER = new Set(['taskSuccessRate', 'recoveryRate'])

/**
 * Gating metrics — a regression here blocks a flag default-on (Plan Rule 6). Latency and cost are
 * reported but not gating (a phase may accept a cost increase for a correctness gain, with a
 * written reason).
 */
const GATING = new Set(['taskSuccessRate', 'hallucinationRate', 'unauthorizedEffectRate', 'recoveryRate'])

function delta(metric: string, before: number | null, after: number | null): MetricDelta {
  if (before === null || after === null) {
    return { metric, before, after, delta: null, regression: false }
  }
  const d = after - before
  const worse = HIGHER_IS_BETTER.has(metric) ? d < 0 : d > 0
  // Ignore sub-epsilon noise.
  const regression = worse && Math.abs(d) > 1e-9
  return { metric, before, after, delta: d, regression }
}

export function diffReports(before: BenchmarkReport, after: BenchmarkReport, arm: string): ReportDiff {
  const b: ArmAggregate | undefined = before.perArm[arm]
  const a: ArmAggregate | undefined = after.perArm[arm]
  if (!b || !a) {
    return { arm, deltas: [], regressed: false, regressions: [`arm "${arm}" missing from ${!b ? 'before' : 'after'} report`] }
  }
  const metrics: [string, number | null, number | null][] = [
    ['taskSuccessRate', b.taskSuccessRate, a.taskSuccessRate],
    ['hallucinationRate', b.hallucinationRate, a.hallucinationRate],
    ['unauthorizedEffectRate', b.unauthorizedEffectRate, a.unauthorizedEffectRate],
    ['recoveryRate', b.recoveryRate, a.recoveryRate],
    ['meanLatencyMs', b.meanLatencyMs, a.meanLatencyMs],
    ['meanCostUsd', b.meanCostUsd, a.meanCostUsd],
  ]
  const deltas = metrics.map(([m, bv, av]) => delta(m, bv, av))
  const regressions = deltas.filter((d) => d.regression && GATING.has(d.metric)).map((d) => d.metric)
  return { arm, deltas, regressed: regressions.length > 0, regressions }
}

export function renderDiff(diff: ReportDiff): string {
  const lines = [`### Rule 6 diff — arm \`${diff.arm}\``, '']
  lines.push('| Metric | Before | After | Δ | Gating regression |')
  lines.push('|---|---|---|---|---|')
  for (const d of diff.deltas) {
    const fmt = (v: number | null) =>
      v === null ? '—' : d.metric.endsWith('Ms') ? `${Math.round(v)}` : d.metric.endsWith('Usd') ? v.toFixed(4) : `${(v * 100).toFixed(1)}%`
    const dd = d.delta === null ? '—' : d.metric.endsWith('Ms') ? `${d.delta > 0 ? '+' : ''}${Math.round(d.delta)}` : d.metric.endsWith('Usd') ? `${d.delta > 0 ? '+' : ''}${d.delta.toFixed(4)}` : `${d.delta > 0 ? '+' : ''}${(d.delta * 100).toFixed(1)}%`
    lines.push(`| ${d.metric} | ${fmt(d.before)} | ${fmt(d.after)} | ${dd} | ${d.regression && GATING.has(d.metric) ? '**YES**' : ''} |`)
  }
  lines.push('')
  lines.push(diff.regressed ? `**REGRESSED** on: ${diff.regressions.join(', ')} — flag may not default on without an accepted-reason override.` : '_No gating regression._')
  return lines.join('\n')
}
