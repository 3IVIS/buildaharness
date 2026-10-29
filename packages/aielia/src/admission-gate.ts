/**
 * Admission gate (plan decisions D11, D12, D26): decides whether a candidate harness change beat the incumbent on
 * evidence the proposer never saw. Pure and deterministic; the caller supplies the runs.
 *
 * Output is `accepted`, a `label` (`screen` or `certificate`) and every reason. `certificate` needs the paired loss
 * difference plus sqrt(2 ln(K*T/delta)/m) below zero AND that confidence term at most 0.1; at the corpus size we have
 * it is always `screen` (D12). `strategy-evidence.ts` stays its own caller; its Wilson bound is reused for display only.
 */
import { wilsonLowerBound } from '@buildaharness/harness'

/** Model, decoding and judge versions of one arm. Compared by exact equality of every field. */
export type ArmVersions = Record<string, string>

/** Per-task run scores in [0, 1], one entry per repeated run. */
export type ArmResults = Record<string, number[]>

export interface ArmRecord {
  results: ArmResults
  /** Mean cost of one run across the partition's tasks, any consistent unit. */
  cost: number
  versions: ArmVersions
}

export interface PartitionInput {
  name: string
  incumbent: ArmRecord
  candidate: ArmRecord
  /** Whether the candidate's changed layer or setting fired on the evaluated tasks. */
  beaconFired: boolean
  /** Whether the proposer ever saw this partition; such a partition never counts as evidence. */
  proposerSaw: boolean
}

export interface GateConfig {
  /** Minimum paired improvement (and tolerated regression), in score units. */
  deadband: number
  /** The Ladder step; scores are quantised down to a multiple of it. */
  ladderStep: number
  /** Cost rise tolerated with no gain, as a fraction of the incumbent's cost. */
  costTolerance: number
  /** Extra gain required per unit of relative cost rise beyond the tolerance. */
  costGainWeight: number
  /** Candidates times rounds (K*T) for the multiplicity correction. */
  candidatesTimesRounds: number
  delta: number
  /** The largest confidence term at which `certificate` is allowed. */
  certificateMaxTerm: number
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  deadband: 0.05,
  ladderStep: 0.02,
  costTolerance: 0.1,
  costGainWeight: 0.1,
  candidatesTimesRounds: 20,
  delta: 0.05,
  certificateMaxTerm: 0.1,
}

export interface GateInput {
  partitions: PartitionInput[]
  /** True when the change turns a layer on; then the beacon must have fired. */
  turnsLayerOn: boolean
  /** Best quantised candidate score recorded so far on the unseen partitions (the Ladder reference). */
  bestRecordedScore: number
  config?: Partial<GateConfig>
}

export type GateReasonCode =
  | 'empty_input' | 'malformed_scores' | 'task_ids_differ' | 'versions_differ' | 'no_unseen_partition'
  | 'gain_below_deadband' | 'not_beating_best_recorded' | 'partition_regressed' | 'cost_without_gain' | 'beacon_not_fired'

export interface GateReason { code: GateReasonCode; partition?: string; detail: string }

export interface PartitionSummary {
  name: string
  counted: boolean
  tasks: number
  incumbentMean: number
  candidateMean: number
  /** Paired improvement in score; positive is better. */
  gain: number
  /** Wilson lower bounds on the mean score, for display only. */
  incumbentWilson: number
  candidateWilson: number
}

export interface GateResult {
  accepted: boolean
  label: 'screen' | 'certificate'
  reasons: GateReason[]
  partitions: PartitionSummary[]
  /** The unseen partition the decision rests on, if any. */
  decidingPartition?: string
  /** Quantised candidate score on the deciding partition; the caller records it as the new best when accepted. */
  quantisedScore?: number
  confidenceTerm?: number
  pairedLossDifference?: number
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const taskMean = (r: ArmResults, id: string): number => mean(r[id] ?? [])
const armMean = (r: ArmResults): number => mean(Object.keys(r).map((id) => taskMean(r, id)))

export function quantise(score: number, step: number): number {
  if (step <= 0) return score
  return Math.floor(score / step + 1e-9) * step
}

function validScores(r: ArmResults): boolean {
  const ids = Object.keys(r)
  if (ids.length === 0) return false
  return ids.every((id) => Array.isArray(r[id]) && r[id].length > 0 && r[id].every((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 1))
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

function sameVersions(a: ArmVersions, b: ArmVersions): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/** The confidence term of the paired-loss bound: sqrt(2 ln(K*T/delta) / m). */
export function confidenceTerm(m: number, cfg: Pick<GateConfig, 'candidatesTimesRounds' | 'delta'>): number {
  if (m <= 0) return Infinity
  return Math.sqrt((2 * Math.log(cfg.candidatesTimesRounds / cfg.delta)) / m)
}

export function admit(input: GateInput): GateResult {
  const cfg: GateConfig = { ...DEFAULT_GATE_CONFIG, ...(input.config ?? {}) }
  const reasons: GateReason[] = []
  const summaries: PartitionSummary[] = []
  const reject = (): GateResult => ({ accepted: false, label: 'screen', reasons, partitions: summaries })

  const parts = Array.isArray(input.partitions) ? input.partitions : []
  if (parts.length === 0) {
    reasons.push({ code: 'empty_input', detail: 'no partitions were supplied' })
    return reject()
  }

  let structural = false
  for (const p of parts) {
    if (!p || !p.incumbent || !p.candidate || !p.incumbent.results || !p.candidate.results) {
      reasons.push({ code: 'empty_input', partition: p?.name, detail: 'a partition is missing an arm or its results' })
      structural = true
      continue
    }
    if (!validScores(p.incumbent.results) || !validScores(p.candidate.results)) {
      reasons.push({ code: Object.keys(p.incumbent.results).length === 0 || Object.keys(p.candidate.results).length === 0 ? 'empty_input' : 'malformed_scores', partition: p.name, detail: 'results are empty, or a task has no runs or a score outside [0, 1]' })
      structural = true
      continue
    }
    if (!sameSet(Object.keys(p.incumbent.results), Object.keys(p.candidate.results))) {
      reasons.push({ code: 'task_ids_differ', partition: p.name, detail: 'incumbent and candidate ran different task ids' })
      structural = true
    }
    if (!p.incumbent.versions || !p.candidate.versions || !sameVersions(p.incumbent.versions, p.candidate.versions)) {
      reasons.push({ code: 'versions_differ', partition: p.name, detail: 'model, decoding or judge versions differ between the arms' })
      structural = true
    }
  }
  if (structural) return reject()

  for (const p of parts) {
    const ids = Object.keys(p.incumbent.results)
    const incMean = armMean(p.incumbent.results)
    const candMean = armMean(p.candidate.results)
    summaries.push({
      name: p.name,
      counted: !p.proposerSaw,
      tasks: ids.length,
      incumbentMean: incMean,
      candidateMean: candMean,
      gain: mean(ids.map((id) => taskMean(p.candidate.results, id) - taskMean(p.incumbent.results, id))),
      incumbentWilson: wilsonLowerBound(incMean * ids.length, ids.length),
      candidateWilson: wilsonLowerBound(candMean * ids.length, ids.length),
    })
  }

  // (5) no partition worse than the incumbent beyond the deadband (seen partitions included: a regression is a regression).
  for (const s of summaries) {
    if (s.gain < -cfg.deadband - 1e-9) reasons.push({ code: 'partition_regressed', partition: s.name, detail: `gain ${s.gain.toFixed(3)} is worse than the deadband -${cfg.deadband}` })
  }

  // (3, 4) only unseen partitions count; pick the one with the largest paired gain.
  const unseen = summaries.filter((s) => s.counted)
  if (unseen.length === 0) {
    reasons.push({ code: 'no_unseen_partition', detail: 'every partition was seen by the proposer, so none counts as evidence' })
    return reject()
  }
  const best = unseen.reduce((a, b) => (b.gain > a.gain ? b : a))
  const quantised = quantise(best.candidateMean, cfg.ladderStep)
  if (best.gain < cfg.deadband - 1e-9) {
    reasons.push({ code: 'gain_below_deadband', partition: best.name, detail: `best unseen gain ${best.gain.toFixed(3)} is below the deadband ${cfg.deadband}` })
  }
  if (quantised < quantise(input.bestRecordedScore, cfg.ladderStep) + cfg.ladderStep - 1e-9) {
    reasons.push({ code: 'not_beating_best_recorded', partition: best.name, detail: `quantised score ${quantised.toFixed(3)} does not beat the best recorded ${input.bestRecordedScore} by the step ${cfg.ladderStep}` })
  }

  // (6) cost may not rise unless a quality gain pays for it.
  const incCost = mean(parts.map((p) => p.incumbent.cost))
  const candCost = mean(parts.map((p) => p.candidate.cost))
  const rise = incCost > 0 ? (candCost - incCost) / incCost : candCost > 0 ? Infinity : 0
  if (rise > cfg.costTolerance) {
    const required = cfg.deadband + (rise - cfg.costTolerance) * cfg.costGainWeight
    if (!(best.gain >= required - 1e-9)) {
      reasons.push({ code: 'cost_without_gain', detail: `cost rose ${(rise * 100).toFixed(0)}% and gain ${best.gain.toFixed(3)} is below the ${required.toFixed(3)} it must pay` })
    }
  }

  // (7) a layer being turned on must have fired on the evaluated tasks.
  if (input.turnsLayerOn && !parts.some((p) => !p.proposerSaw && p.beaconFired)) {
    reasons.push({ code: 'beacon_not_fired', detail: 'the layer was turned on but its beacon never fired on an unseen partition' })
  }

  const accepted = reasons.length === 0
  const bestPart = parts.find((p) => p.name === best.name)!
  const ids = Object.keys(bestPart.incumbent.results)
  const lossDiff = -best.gain
  const term = confidenceTerm(ids.length, cfg)
  const label: GateResult['label'] = accepted && lossDiff + term < 0 && term <= cfg.certificateMaxTerm ? 'certificate' : 'screen'
  return { accepted, label, reasons, partitions: summaries, decidingPartition: best.name, quantisedScore: quantised, confidenceTerm: term, pairedLossDifference: lossDiff }
}
