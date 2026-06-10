import type { Evidence, EvidenceStore, Reliability } from '../state/evidence-store.js'

export interface GatherEvidenceInput {
  id: string
  obs: string
  source: string
  evidence_type: 'OBSERVATION' | 'INFERENCE' | 'SYSTEM_ERROR'
  freshness?: string
  reliability?: Reliability
}

export function gatherEvidence(
  input: GatherEvidenceInput,
  evidenceStore: EvidenceStore,
  onWarning?: (message: string) => void,
): Evidence | undefined {
  if (!evidenceStore.isToolAvailable(input.source)) {
    onWarning?.(`gatherEvidence: tool "${input.source}" unavailable; no evidence collected`)
    return undefined
  }

  // SYSTEM_ERROR always carries HIGH reliability regardless of what was passed
  const reliability: Reliability =
    input.evidence_type === 'SYSTEM_ERROR' ? 'HIGH' : (input.reliability ?? 'MEDIUM')

  const evidence: Evidence = {
    id: input.id,
    obs: input.obs,
    reliability,
    source: input.source,
    evidence_type: input.evidence_type,
    freshness: input.freshness ?? new Date().toISOString(),
  }

  // Stored in observations[] — never auto-promoted to beliefs[]
  evidenceStore.addObservation(evidence)
  return evidence
}
