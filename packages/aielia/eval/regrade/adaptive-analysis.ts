/**
 * Analysis of the AL11a cells (AL11b of plans/adaptive_layer_selection_plan.html).
 *
 * Reads finalized audit transcripts and, for every `adaptive-vs-*` cell (the ablation cells feed layer-value.ts instead), applies in order:
 *   1. the invalid-rows rule (AL-6): an arm with > 5% invalid rows is not read — re-run it;
 *   2. the certificate re-check (AL-9): the slice's AL1f certificate must exist and pass, and its
 *      engagement / headroom thresholds must also hold on the *actual* run. A slice with no
 *      certificate is `UNTESTED` and never scored;
 *   3. the D2 bar: success non-inferior (lower CI ≥ −3pt) AND cost ≥ 25% lower, overall and
 *      per category, so a regression hidden in an average (ambiguity, injection) is caught.
 *
 * Pure functions except `loadCells` / the CLI. Test/tooling only.
 *
 *   npx tsx eval/regrade/adaptive-analysis.ts [--feature=<manifest id>] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TaskSpec } from '../corpus/schema.js'
import { MAX_CONTROL_FAILURE, MIN_CONTROL_FAILURE, MIN_ENGAGEMENT, type ProbeCertificate } from './engagement-probe.js'
import { LAYER_SOURCES, loadCertificates, loadFeatureRuns, MIN_PAIRS, pairedDelta, pairRuns, type Delta, type LayerRun, type Pair } from './layer-value.js'

/** D2 bar (plan AL-3/D2): success lower CI ≥ −3pt, cost at least 25% lower. */
export const D2_SUCCESS_NONINFERIORITY = -0.03
export const D2_MIN_COST_REDUCTION = 0.25
/** An arm with more than this share of invalid rows is not read. */
export const MAX_INVALID_RATE = 0.05

export type CellStatus = 'REFUSED_INVALID_ROWS' | 'UNTESTED' | 'SCORED'

export interface InvalidRowsCheck {
  ok: boolean
  /** Per arm: invalid / total rows. */
  arms: Array<{ arm: string; total: number; invalid: number; rate: number }>
  reason: string
}

/** AL-6: any arm with > 5% invalid rows means the run must be repeated before its result is read. */
export function checkInvalidRows(runs: readonly LayerRun[], arms: readonly string[]): InvalidRowsCheck {
  const stats = arms.map((arm) => {
    const rows = runs.filter((r) => r.arm === arm)
    const invalid = rows.filter((r) => r.invalid).length
    return { arm, total: rows.length, invalid, rate: rows.length === 0 ? 0 : invalid / rows.length }
  })
  const bad = stats.filter((s) => s.rate > MAX_INVALID_RATE)
  return {
    ok: bad.length === 0,
    arms: stats,
    reason: bad.length === 0 ? '' : `arm(s) ${bad.map((s) => `${s.arm} (${s.invalid}/${s.total} = ${(s.rate * 100).toFixed(1)}%)`).join(', ')} exceed ${MAX_INVALID_RATE * 100}% invalid rows — re-run before reading`,
  }
}

export interface CertificateCheck {
  ok: boolean
  reason: string
}

const rateOf = (xs: readonly boolean[]): number | null => (xs.length === 0 ? null : xs.filter(Boolean).length / xs.length)

/**
 * Re-check every required mechanism's certificate against the run that was actually made. No
 * certificate, a failed one, or actual engagement/headroom below the certificate thresholds ⇒ not ok.
 * `mechanisms: []` (a full-corpus cell with no slice) needs no certificate.
 */
export function recheckCertificates(
  mechanisms: readonly string[],
  certificates: Readonly<Record<string, ProbeCertificate>>,
  pairs: readonly Pair[],
  activityLayers: Readonly<Record<string, string | undefined>> = {},
): CertificateCheck {
  for (const m of mechanisms) {
    const cert = certificates[m]
    if (!cert) return { ok: false, reason: `no adequacy certificate on record for "${m}" (AL1f not done or the slice failed it)` }
    if (!cert.certified) return { ok: false, reason: `certificate for "${m}" failed: ${cert.failed.join('; ') || 'thresholds not met'}` }
    const layer = activityLayers[m]
    const engagement = rateOf(pairs.map((p) => (layer ? p.on.firedLayers.includes(layer) : p.on.llmCalls !== p.off.llmCalls)))
    if (engagement === null || engagement < MIN_ENGAGEMENT)
      return { ok: false, reason: `"${m}" engaged on ${engagement === null ? 'no' : `${(engagement * 100).toFixed(0)}%`} of the actual run's pairs (need ≥ ${MIN_ENGAGEMENT * 100}%)` }
    const failure = rateOf(pairs.map((p) => !p.off.success))
    if (failure === null || failure < MIN_CONTROL_FAILURE || failure > MAX_CONTROL_FAILURE)
      return { ok: false, reason: `control failure rate on the actual run is ${failure === null ? 'n/a' : `${(failure * 100).toFixed(0)}%`} (need ${MIN_CONTROL_FAILURE * 100}–${MAX_CONTROL_FAILURE * 100}%) — no headroom measured` }
  }
  return { ok: true, reason: '' }
}

export interface D2Result {
  pairs: number
  success: Delta
  /** 1 − candidate mean cost / control mean cost; positive = cheaper. `null` with no cost data. */
  costReduction: number | null
  successNonInferior: boolean
  costOk: boolean
  pass: boolean
}

const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** The D2 bar over one set of pairs (`on` = the candidate, e.g. adaptivePolicy). */
export function d2Bar(pairs: readonly Pair[]): D2Result {
  const success = pairedDelta(pairs.map((p) => Number(p.on.success) - Number(p.off.success)))
  const offCost = pairs.length === 0 ? 0 : meanOf(pairs.map((p) => p.off.costUsd))
  const costReduction = pairs.length === 0 || offCost <= 0 ? null : 1 - meanOf(pairs.map((p) => p.on.costUsd)) / offCost
  const successNonInferior = success.ci !== null && success.ci[0] >= D2_SUCCESS_NONINFERIORITY
  const costOk = costReduction !== null && costReduction >= D2_MIN_COST_REDUCTION
  return { pairs: pairs.length, success, costReduction, successNonInferior, costOk, pass: successNonInferior && costOk }
}

export interface CategoryResult extends D2Result {
  category: string
  /** Success got measurably worse in this category: the point estimate is below the non-inferiority margin. */
  regressed: boolean
}

/**
 * Per-category D2 so an average cannot hide a regression. A category is `regressed` when its
 * success delta's point estimate is worse than −3pt (its CI is usually too wide to prove
 * non-inferiority at these sizes, so the point estimate is the tripwire). Categories with fewer
 * than `MIN_PAIRS` pairs are omitted.
 */
export function perCategory(pairs: readonly Pair[]): CategoryResult[] {
  const cats = [...new Set(pairs.map((p) => p.on.category))].sort()
  const out: CategoryResult[] = []
  for (const category of cats) {
    const sub = pairs.filter((p) => p.on.category === category)
    if (sub.length < MIN_PAIRS) continue
    const r = d2Bar(sub)
    out.push({ ...r, category, regressed: r.success.mean < D2_SUCCESS_NONINFERIORITY })
  }
  return out
}

export interface CellSpec {
  /** Manifest feature id (also the audit directory name). */
  feature: string
  onArm: string
  offArm: string
  /** Mechanisms whose AL1f certificates the cell's slice(s) depend on; empty for a full-corpus cell. */
  mechanisms: readonly string[]
}

export interface CellAnalysis {
  feature: string
  onArm: string
  offArm: string
  status: CellStatus
  reason: string
  invalidRows: InvalidRowsCheck
  overall?: D2Result
  categories?: CategoryResult[]
  /** Only for SCORED cells: overall D2 pass AND no regressed category. */
  d2Pass?: boolean
}

export function analyzeCell(
  cell: CellSpec,
  runs: readonly LayerRun[],
  certificates: Readonly<Record<string, ProbeCertificate>>,
  activityLayers: Readonly<Record<string, string | undefined>> = {},
): CellAnalysis {
  const base = { feature: cell.feature, onArm: cell.onArm, offArm: cell.offArm }
  const invalidRows = checkInvalidRows(runs, [cell.onArm, cell.offArm])
  if (!invalidRows.ok) return { ...base, status: 'REFUSED_INVALID_ROWS', reason: invalidRows.reason, invalidRows }
  const pairs = pairRuns(runs, cell.onArm, cell.offArm)
  const cert = recheckCertificates(cell.mechanisms, certificates, pairs, activityLayers)
  if (!cert.ok) return { ...base, status: 'UNTESTED', reason: cert.reason, invalidRows }
  const overall = d2Bar(pairs)
  const categories = perCategory(pairs)
  const regressed = categories.filter((c) => c.regressed).map((c) => c.category)
  return {
    ...base,
    status: 'SCORED',
    reason: regressed.length > 0 ? `regressed categories: ${regressed.join(', ')}` : '',
    invalidRows,
    overall,
    categories,
    d2Pass: overall.pass && regressed.length === 0,
  }
}

export function renderAnalysisMarkdown(results: readonly CellAnalysis[]): string {
  const pt = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pt`
  const lines = ['# Adaptive-layer cell analysis', '', '| cell | arms | status | success Δ (95% CI) | cost reduction | D2 |', '|---|---|---|---|---|---|']
  for (const r of results) {
    const o = r.overall
    lines.push(
      `| ${r.feature} | ${r.onArm} vs ${r.offArm} | ${r.status}${r.reason ? ` — ${r.reason}` : ''} | ${o ? `${pt(o.success.mean)}${o.success.ci ? ` (${pt(o.success.ci[0])}, ${pt(o.success.ci[1])})` : ''}` : '—'} | ${o?.costReduction != null ? `${(o.costReduction * 100).toFixed(0)}%` : '—'} | ${r.d2Pass === undefined ? '—' : r.d2Pass ? 'PASS' : 'FAIL'} |`,
    )
  }
  return lines.join('\n') + '\n'
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = dirname(HERE)

interface ManifestFeature {
  id: string
  arms: [string, string]
  slice?: string | null
}

/**
 * Mechanisms an AL11a adaptive cell depends on: an all-probes cell (or one part `-a`/`-b` of a split all-probes cell)
 * needs every probed layer it actually runs; a full-corpus or smoke cell none. With `cellSlice` + `probeSlices`
 * (probe feature id → its slice) a split part is limited to the layers whose probe slices it covers, so it isn't
 * held UNTESTED on a layer belonging to the other part. Without them, every probed layer (the unsplit behaviour).
 */
export function mechanismsForCell(id: string, cellSlice?: string | null, probeSlices?: ReadonlyMap<string, string | null | undefined>): string[] {
  if (!id.startsWith('adaptive-vs-') || !/-probes(-[a-z])?$/.test(id)) return []
  const covered = cellSlice ? new Set(cellSlice.split(',').map((x) => x.trim())) : null
  const runs = (feature: string): boolean => {
    if (!covered || !probeSlices) return true
    const sl = probeSlices.get(feature)
    return !!sl && sl.split(',').every((x) => covered.has(x.trim()))
  }
  return [...new Set(LAYER_SOURCES.filter((s) => s.feature.startsWith('probe-') && runs(s.feature)).map((s) => s.mechanism))].sort()
}

async function main(): Promise<void> {
  const { loadCorpus } = await import('../corpus/index.js')
  const tasks = new Map<string, TaskSpec>(loadCorpus().map((t) => [t.id, t]))
  const manifest = JSON.parse(readFileSync(join(EVAL, 'audit', 'manifest.json'), 'utf8')) as { features: ManifestFeature[] }
  const only = process.argv.find((a) => a.startsWith('--feature='))?.slice('--feature='.length)
  const probeSlices = new Map(manifest.features.map((f) => [f.id, f.slice] as const))
  const certificates = loadCertificates(join(HERE, 'certificates.json'))
  const activityLayers = Object.fromEntries(LAYER_SOURCES.map((s) => [s.mechanism, s.activityLayer]))
  const results: CellAnalysis[] = []
  for (const f of manifest.features) {
    if (only ? f.id !== only : !f.id.startsWith('adaptive-vs-')) continue
    const runs = loadFeatureRuns(join(EVAL, 'reports', 'audit'), f.id, tasks)
    if (!runs || runs.length === 0) continue // cell has not finalized yet
    results.push(analyzeCell({ feature: f.id, onArm: f.arms[1], offArm: f.arms[0], mechanisms: mechanismsForCell(f.id, f.slice, probeSlices) }, runs, certificates, activityLayers))
  }
  console.log(process.argv.includes('--json') ? JSON.stringify(results, null, 2) : renderAnalysisMarkdown(results))
  if (results.some((r) => r.status === 'REFUSED_INVALID_ROWS')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && existsSync(EVAL)) void main()
