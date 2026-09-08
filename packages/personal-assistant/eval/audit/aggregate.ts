/**
 * Fold a feature's N seed reports into one verdict.
 *
 * Reuses `report.ts`'s `aggregateSeeds` / `diffSeeds` (the Rule 6 machinery) and adds the audit's
 * KEEP / CUT / INCONCLUSIVE call as a pure function, so the driver and a human reading the
 * benchmark doc reach the same conclusion from the same numbers.
 *
 * Arm-pair convention (see types.ts): `arms = [control, candidate]`, and `diffSeeds(a, b)` treats
 * `b` as the candidate — so we diff `(control, candidate)` and a `positive` verdict means the
 * candidate (feature present) beat the control (feature absent) on task success.
 */
import type { BenchmarkReport } from '../runner.js'
import { aggregateSeeds, diffSeeds, type SeedDiff } from '../report.js'
import type { AuditVerdict } from './types.js'

export interface AuditResult {
  feature: string
  control: string
  candidate: string
  seeds: number
  diff: SeedDiff
  verdict: AuditVerdict
  /** One sentence — why this verdict, in the audit's own terms. */
  rationale: string
  /** Candidate-vs-control deltas surfaced for the registry row. */
  costDeltaPct: number | null
  latencyDeltaPct: number | null
  tokenDeltaPct: number | null
}

function deltaPct(diff: SeedDiff, metric: string): number | null {
  const d = diff.deltas.find((x) => x.metric === metric)
  if (!d || d.meanA === null || d.meanB === null || d.meanA === 0) return null
  return (d.meanB - d.meanA) / d.meanA
}

/** A candidate that costs materially more than the control — the bar "neutral with real cost" clears. */
const MATERIAL_COST_INCREASE = 0.1 // +10% on any of cost / latency / tokens

export function auditVerdict(seedReports: BenchmarkReport[], control: string, candidate: string, feature: string): AuditResult {
  const seeds = seedReports.length
  const a = aggregateSeeds(seedReports, control)
  const b = aggregateSeeds(seedReports, candidate)
  const diff = diffSeeds(a, b)

  const costDeltaPct = deltaPct(diff, 'meanCostUsd')
  const latencyDeltaPct = deltaPct(diff, 'meanLatencyMs')
  const tokenDeltaPct = deltaPct(diff, 'totalTokens')
  const costlier = [costDeltaPct, latencyDeltaPct, tokenDeltaPct].some((x) => x !== null && x > MATERIAL_COST_INCREASE)

  const successStat = b.stats['taskSuccessRate']
  const underpowered = seeds < 3 || (successStat?.n ?? 0) < 2

  let verdict: AuditVerdict
  let rationale: string

  if (diff.verdict === 'regressed') {
    verdict = 'CUT'
    const worse = diff.deltas.filter((d) => d.regressed).map((d) => d.metric).join(', ')
    rationale = `The candidate regressed a gating metric (${worse}) beyond its CI band — the feature makes outcomes worse on its own stress slice.`
  } else if (diff.verdict === 'positive') {
    verdict = 'KEEP'
    rationale = costlier
      ? `The candidate beats the control on task success (CI clears 0) and the gain justifies its higher cost (${fmtPct(costDeltaPct)} $/turn).`
      : `The candidate beats the control on task success (CI clears 0) with no material cost increase.`
  } else if (underpowered) {
    verdict = 'INCONCLUSIVE'
    rationale = `No significant task-success delta at ${seeds} seed(s) — underpowered. Expand the corpus or seeds and re-run before deciding.`
  } else if (costlier) {
    verdict = 'CUT'
    rationale = `No task-success delta (CI includes 0) but the candidate costs materially more (${fmtPct(costDeltaPct)} $/turn, ${fmtPct(latencyDeltaPct)} latency). Neutral with real cost — it does not earn its keep.`
  } else {
    verdict = 'INCONCLUSIVE'
    rationale = `No task-success delta and no material cost difference — the feature neither helps nor hurts measurably on this slice. Not enough to keep it on by default; not enough to cut with confidence.`
  }

  return {
    feature,
    control,
    candidate,
    seeds,
    diff,
    verdict,
    rationale,
    costDeltaPct,
    latencyDeltaPct,
    tokenDeltaPct,
  }
}

function fmtPct(x: number | null): string {
  if (x === null) return '—'
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(0)}%`
}
