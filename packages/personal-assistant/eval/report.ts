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
  lines.push('### AnswerClaim calibration')
  lines.push('')
  lines.push(
    'Over the tasks that produced an AnswerClaim **and** carry a mechanical ground truth. ' +
      'The **overconfident-and-wrong** cell (claim says `verified`, answer actually wrong) is a ' +
      'Rule 6 gating signal — a rise in it is a regression.',
  )
  lines.push('')
  for (const a of arms) {
    const m = a.answerClaimConfusion
    lines.push(`**\`${a.arm}\`** — ${m ? `${m.tasks} AnswerClaim task(s)` : 'no AnswerClaim-producing tasks'}`)
    lines.push('')
    if (m) {
      lines.push('| | answer correct | answer wrong |')
      lines.push('|---|---|---|')
      lines.push(`| claim = \`verified\` | ${m.verifiedCorrect} | ${m.verifiedWrong} |`)
      lines.push(`| claim ≠ \`verified\` | ${m.unverifiedCorrect} | ${m.unverifiedWrong} |`)
      lines.push('')
      lines.push(`overconfident-and-wrong: ${m.verifiedWrong}/${m.tasks} (${pct(m.overconfidentWrongRate)})`)
      lines.push('')
    }
  }
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
const GATING = new Set([
  'taskSuccessRate',
  'hallucinationRate',
  'unauthorizedEffectRate',
  'recoveryRate',
  // AnswerClaim calibration: an assistant that says `verified` about a wrong answer is worse than
  // one that stays honest about its uncertainty. A rise here is a regression (Plan Rule 6),
  // lower is better. `null` on both sides (no AnswerClaim tasks ran) → no delta, never gates.
  'overconfidentWrongRate',
])

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
    ['overconfidentWrongRate', b.answerClaimConfusion?.overconfidentWrongRate ?? null, a.answerClaimConfusion?.overconfidentWrongRate ?? null],
    ['meanLatencyMs', b.meanLatencyMs, a.meanLatencyMs],
    ['meanCostUsd', b.meanCostUsd, a.meanCostUsd],
  ]
  const deltas = metrics.map(([m, bv, av]) => delta(m, bv, av))
  const regressions = deltas.filter((d) => d.regression && GATING.has(d.metric)).map((d) => d.metric)
  return { arm, deltas, regressed: regressions.length > 0, regressions }
}

// ── Multi-seed aggregation (S7 — the decision is LLM-driven, one pass is not evidence) ──────

/** One metric summarised across N independent seed runs of the same arm. */
export interface SeedStat {
  metric: string
  /** Per-seed values that were present (a `null` metric in a seed is dropped). */
  values: number[]
  mean: number | null
  stddev: number | null
  /** 95% confidence half-width: 1.96 · stddev / √n. */
  ci95: number | null
  n: number
}

export interface SeedAggregate {
  arm: string
  seeds: number
  stats: Record<string, SeedStat>
}

const SEED_METRICS: Array<[string, (a: ArmAggregate) => number | null]> = [
  ['taskSuccessRate', (a) => a.taskSuccessRate],
  ['hallucinationRate', (a) => a.hallucinationRate],
  ['unauthorizedEffectRate', (a) => a.unauthorizedEffectRate],
  ['recoveryRate', (a) => a.recoveryRate],
  ['overconfidentWrongRate', (a) => a.answerClaimConfusion?.overconfidentWrongRate ?? null],
  ['supervisorConsultsMean', (a) => a.supervisorConsultsMean],
  ['meanLatencyMs', (a) => a.meanLatencyMs],
  ['meanCostUsd', (a) => a.meanCostUsd],
  ['totalTokens', (a) => a.totalTokens],
]

function summarise(metric: string, values: number[]): SeedStat {
  const n = values.length
  if (n === 0) return { metric, values, mean: null, stddev: null, ci95: null, n: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / n
  if (n === 1) return { metric, values, mean, stddev: 0, ci95: 0, n }
  // Sample standard deviation (n − 1).
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
  const stddev = Math.sqrt(variance)
  return { metric, values, mean, stddev, ci95: (1.96 * stddev) / Math.sqrt(n), n }
}

/** Fold N per-seed BenchmarkReports into one per-metric mean/stddev/CI summary for `arm`. */
export function aggregateSeeds(reports: BenchmarkReport[], arm: string): SeedAggregate {
  const stats: Record<string, SeedStat> = {}
  for (const [metric, pick] of SEED_METRICS) {
    const values: number[] = []
    for (const r of reports) {
      const agg = r.perArm[arm]
      if (!agg) continue
      const v = pick(agg)
      if (v !== null && Number.isFinite(v)) values.push(v)
    }
    stats[metric] = summarise(metric, values)
  }
  return { arm, seeds: reports.length, stats }
}

export interface SeedMetricDelta {
  metric: string
  meanA: number | null
  meanB: number | null
  deltaMean: number | null
  /** Combined 95% half-width (√(ci_a² + ci_b²)) — a crude but standard independent-sample band. */
  deltaCi95: number | null
  /** deltaMean − deltaCi95 clears 0 in the better direction. */
  positive: boolean
  /** A gating metric moved in the worse direction by more than its combined CI band. */
  regressed: boolean
}

export interface SeedDiff {
  armA: string
  armB: string
  deltas: SeedMetricDelta[]
  /** armB beats armA on taskSuccessRate with CI clearing 0, and nothing gating regressed. */
  verdict: 'positive' | 'neutral' | 'regressed'
}

/** Rule-6 delta between two arms, each already `aggregateSeeds`-summarised. armB is the candidate. */
export function diffSeeds(a: SeedAggregate, b: SeedAggregate): SeedDiff {
  const deltas: SeedMetricDelta[] = []
  for (const [metric] of SEED_METRICS) {
    const sa = a.stats[metric]
    const sb = b.stats[metric]
    if (!sa || !sb || sa.mean === null || sb.mean === null) {
      deltas.push({ metric, meanA: sa?.mean ?? null, meanB: sb?.mean ?? null, deltaMean: null, deltaCi95: null, positive: false, regressed: false })
      continue
    }
    const deltaMean = sb.mean - sa.mean
    const deltaCi95 = Math.sqrt((sa.ci95 ?? 0) ** 2 + (sb.ci95 ?? 0) ** 2)
    const higherBetter = HIGHER_IS_BETTER.has(metric)
    const betterDir = higherBetter ? deltaMean : -deltaMean
    const positive = betterDir - deltaCi95 > 1e-9
    const regressed = GATING.has(metric) && betterDir + deltaCi95 < -1e-9
    deltas.push({ metric, meanA: sa.mean, meanB: sb.mean, deltaMean, deltaCi95, positive, regressed })
  }
  const success = deltas.find((d) => d.metric === 'taskSuccessRate')
  const anyRegressed = deltas.some((d) => d.regressed)
  const verdict: SeedDiff['verdict'] = anyRegressed ? 'regressed' : success?.positive ? 'positive' : 'neutral'
  return { armA: a.arm, armB: b.arm, deltas, verdict }
}

export function renderSeedDiff(diff: SeedDiff): string {
  const fmt = (metric: string, v: number | null): string => {
    if (v === null) return '—'
    if (metric.endsWith('Ms')) return `${Math.round(v)}`
    if (metric.endsWith('Usd')) return v.toFixed(4)
    if (metric === 'totalTokens' || metric === 'supervisorConsultsMean') return v.toFixed(3)
    return `${(v * 100).toFixed(1)}%`
  }
  const lines = [`### Rule 6 multi-seed diff — \`${diff.armB}\` vs \`${diff.armA}\``, '']
  lines.push('| Metric | ' + `${diff.armA}` + ' | ' + `${diff.armB}` + ' | Δmean | ±CI95 | verdict |')
  lines.push('|---|---|---|---|---|---|')
  for (const d of diff.deltas) {
    const tag = d.regressed ? '**REGRESSED**' : d.positive ? 'positive' : ''
    lines.push(
      `| ${d.metric} | ${fmt(d.metric, d.meanA)} | ${fmt(d.metric, d.meanB)} | ` +
        `${d.deltaMean === null ? '—' : (d.deltaMean > 0 ? '+' : '') + fmt(d.metric, d.deltaMean)} | ` +
        `${d.deltaCi95 === null ? '—' : fmt(d.metric, d.deltaCi95)} | ${tag} |`,
    )
  }
  lines.push('')
  lines.push(
    diff.verdict === 'positive'
      ? `**POSITIVE** — \`${diff.armB}\` beats \`${diff.armA}\` on taskSuccessRate with the CI clearing 0, no gating regression. Flag may default on.`
      : diff.verdict === 'regressed'
        ? `**REGRESSED** — a gating metric moved worse by more than its CI band. Flag stays OFF.`
        : `**NEUTRAL** — no significant taskSuccessRate delta. Flag stays OFF (S7 "if the delta is not positive" discipline).`,
  )
  return lines.join('\n')
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
