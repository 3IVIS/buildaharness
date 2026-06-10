import type { Evidence, Reliability } from '../state/evidence-store.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { Diagnostics } from '../state/diagnostics.js'
import { normalise, DimensionType } from '../normalise.js'

const RELIABILITY_RANK: Record<Reliability, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 }
const RANK_TO_RELIABILITY: Reliability[] = ['LOW', 'MEDIUM', 'HIGH']

export function applyToolReliability(
  evidence: Evidence,
  evidenceStore: EvidenceStore,
  diagnostics: Diagnostics,
): Evidence {
  const envelope = evidenceStore.tool_reliability_envelopes[evidence.source]
  let cappedReliability = evidence.reliability

  if (envelope) {
    const maxRank = RELIABILITY_RANK[envelope.max_conclusion_reliability]
    const evidenceRank = RELIABILITY_RANK[evidence.reliability]
    if (evidenceRank > maxRank) {
      cappedReliability = RANK_TO_RELIABILITY[maxRank]
    }
  }

  // tool_envelope_gap_count: tools whose max_conclusion_reliability is LOW
  const envelopes = Object.values(evidenceStore.tool_reliability_envelopes)
  const lowCount = envelopes.filter(e => e.max_conclusion_reliability === 'LOW').length
  const total = envelopes.length
  const gapRatio = total > 0 ? lowCount / total : 0
  diagnostics.verification_health.feasibility = normalise(1 - gapRatio, DimensionType.ratio)

  // Return new Evidence object — original not mutated
  return { ...evidence, reliability: cappedReliability }
}
