/**
 * Per-suggestion evidence record (plan section 5): Selection, Activation, Attribution, Improvement. Every field is
 * optional; `describeEvidence` shows an absent one as "missing" rather than hiding it or inventing a value.
 */
import type { PartitionInput } from './admission-gate.js'

export interface EvidenceSelection {
  /** Partition names that fed proposal, ranking, admission and reporting. */
  proposal?: string[]
  ranking?: string[]
  admission?: string[]
  reporting?: string[]
}

export interface EvidenceActivation {
  /** Rates over the runs where the item applies, in [0, 1]. */
  loadRate?: number
  reachRate?: number
  carryRate?: number
}

export interface EvidenceAttribution {
  repeatVariation?: number
  incumbentCost?: number
  candidateCost?: number
  versions?: Record<string, string>
}

export interface EvidenceImprovement {
  taskDistance?: number
  baseline?: number
  round?: number
}

/** The four measures every report carries (D24). `correctionRate` is null only where it is not available. */
export interface EvidenceMeasures {
  gradedPassRate: number
  costPerTask: number
  safetyProbePassRate: number
  correctionRate: number | null
}

/** Result of the arm with all adopted state disabled, next to the candidate's. */
export interface EvidenceAdoptedOff {
  baselineMean: number
  candidateMean: number
}

export interface SuggestionEvidence {
  measures?: EvidenceMeasures
  adoptedOff?: EvidenceAdoptedOff
  /** Share of fixed tasks on which the candidate's beacon fired (fix and break ledger). */
  fixedBeaconShare?: number
  selection?: EvidenceSelection
  activation?: EvidenceActivation
  attribution?: EvidenceAttribution
  improvement?: EvidenceImprovement
  /** Task ids the candidate fixed and broke, per the paired comparison. */
  fixed?: string[]
  broken?: string[]
}

export interface EvidenceLine { section: string; field: string; value: string }

const MISSING = 'missing'

function show(v: unknown): string {
  if (v === undefined || v === null) return MISSING
  if (Array.isArray(v)) return v.length === 0 ? MISSING : v.join(', ')
  if (typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>)
    return e.length === 0 ? MISSING : e.map(([k, x]) => `${k}=${String(x)}`).join(', ')
  }
  return String(v)
}

/** Every field of the record as a line, in a fixed order, with absent ones shown as "missing". */
export function describeEvidence(e: SuggestionEvidence | undefined): EvidenceLine[] {
  const s = e?.selection, a = e?.activation, t = e?.attribution, i = e?.improvement
  const rows: Array<[string, string, unknown]> = [
    ['selection', 'proposal', s?.proposal], ['selection', 'ranking', s?.ranking], ['selection', 'admission', s?.admission], ['selection', 'reporting', s?.reporting],
    ['activation', 'loadRate', a?.loadRate], ['activation', 'reachRate', a?.reachRate], ['activation', 'carryRate', a?.carryRate],
    ['attribution', 'repeatVariation', t?.repeatVariation], ['attribution', 'incumbentCost', t?.incumbentCost], ['attribution', 'candidateCost', t?.candidateCost], ['attribution', 'versions', t?.versions],
    ['improvement', 'taskDistance', i?.taskDistance], ['improvement', 'baseline', i?.baseline], ['improvement', 'round', i?.round],
    ['measures', 'gradedPassRate', e?.measures?.gradedPassRate], ['measures', 'costPerTask', e?.measures?.costPerTask],
    ['measures', 'safetyProbePassRate', e?.measures?.safetyProbePassRate], ['measures', 'correctionRate', e?.measures ? (e.measures.correctionRate ?? 'unavailable') : undefined],
    ['adoptedOff', 'result', e?.adoptedOff], ['ledger', 'fixedBeaconShare', e?.fixedBeaconShare],
    ['tasks', 'fixed', e?.fixed], ['tasks', 'broken', e?.broken],
  ]
  return rows.map(([section, field, v]) => ({ section, field, value: show(v) }))
}

/** Task ids the candidate fixed (mean score up) and broke (mean score down) across the given partitions. */
export function fixBreakList(partitions: PartitionInput[]): { fixed: string[]; broken: string[] } {
  const fixed: string[] = []
  const broken: string[] = []
  const m = (xs: number[] | undefined): number => (xs && xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0)
  for (const p of partitions) {
    for (const id of Object.keys(p.incumbent.results)) {
      const d = m(p.candidate.results[id]) - m(p.incumbent.results[id])
      if (d > 0) fixed.push(`${p.name}/${id}`)
      else if (d < 0) broken.push(`${p.name}/${id}`)
    }
  }
  return { fixed, broken }
}
