import type { Evidence, VerificationResult } from '@buildaharness/harness'

/**
 * Where the evidence backing a reply actually came from — 'tool_evidence' when at least one
 * real observation (a gather_evidence call, a real read_file/web_search result, ...) was
 * recorded this turn, 'model_reasoning' when the harness ran but produced no such observation
 * (a plain-reasoning reply, still gated through the full loop).
 */
export type AnswerClaimSourceType = 'tool_evidence' | 'model_reasoning'

/**
 * The four branches this plan's Validation section names explicitly — each backed by a real,
 * mechanically-derived signal (see buildAnswerClaim), never guessed from the reply text itself:
 * - 'verified': the verification layer found no critical failure and at least one layer
 *   actually PASSed (not just SKIPPED) against real evidence.
 * - 'unverified_attempted': evidence was gathered, but no layer could independently confirm it
 *   (all SKIPPED/no tool to check with) — an honest "couldn't verify," not a fake PASS.
 * - 'contradicted': the Contradiction layer flagged a conflict with an existing belief this turn.
 * - 'no_evidence': no real observation was gathered at all — a plain-reasoning answer.
 */
export type AnswerClaimVerificationStatus = 'verified' | 'unverified_attempted' | 'contradicted' | 'no_evidence'

/**
 * Phase 6 of the harness/assistant remediation plan: a first-class epistemic-honesty signal
 * attached to a reply that went through the harness loop, distinguishing "this is true" from
 * "I found X but couldn't independently verify it." Built entirely from real, already-computed
 * harness signal (Phase 2/3's now-real verification layers, the EvidenceStore's real
 * observations, the Contradiction layer's own finding) — never a new LLM judgment call.
 */
export interface AnswerClaim {
  evidence: Evidence[]
  /** min(verificationHealth.strength, verificationHealth.feasibility) — the same real number chat-ui's "Why?" panel already buckets into plain language. */
  confidence: number
  /** ISO timestamp of the least-fresh evidence backing this claim, or null when there's no evidence at all. */
  freshness: string | null
  source_type: AnswerClaimSourceType
  verification_status: AnswerClaimVerificationStatus
}

/**
 * Builds an AnswerClaim from one turn's real harness output. `verification` is the last
 * VerificationResult HarnessRuntime's onVerification hook reported this turn (null when the
 * turn never reached verify() at all — e.g. the harness was skipped by the triviality fast
 * path, in which case the caller should not attach an AnswerClaim at all rather than call this
 * with a fabricated null).
 */
export function buildAnswerClaim(input: {
  evidence: Evidence[]
  verification: VerificationResult | null
  contradicted: boolean
  verificationHealth: { strength: number; feasibility: number }
}): AnswerClaim {
  const { evidence, verification, contradicted, verificationHealth } = input

  const verification_status: AnswerClaimVerificationStatus = contradicted
    ? 'contradicted'
    : evidence.length === 0
      ? 'no_evidence'
      : verification && !verification.has_critical_failure && verification.layer_results.some((lr) => lr.status === 'PASS')
        ? 'verified'
        : 'unverified_attempted'

  const freshness = evidence.length === 0
    ? null
    : evidence.reduce((oldest, e) => (e.freshness < oldest ? e.freshness : oldest), evidence[0].freshness)

  return {
    evidence,
    confidence: Math.min(verificationHealth.strength, verificationHealth.feasibility),
    freshness,
    source_type: evidence.length > 0 ? 'tool_evidence' : 'model_reasoning',
    verification_status,
  }
}
