import { describe, it, expect } from 'vitest'
import type { Evidence, VerificationResult } from '@buildaharness/harness'
import { buildAnswerClaim } from './answer-claim.js'

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    obs: 'read_file returned 42 lines',
    reliability: 'HIGH',
    source: 'read_file',
    evidence_type: 'OBSERVATION',
    freshness: '2026-08-12T00:00:00.000Z',
    ...overrides,
  }
}

function verification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    layer_results: [],
    has_critical_failure: false,
    adversarial_passed: null,
    ...overrides,
  }
}

const HEALTHY = { strength: 0.9, feasibility: 0.9 }

describe('buildAnswerClaim', () => {
  it('is "verified" when a real evidence-backed layer PASSed and nothing critically failed', () => {
    const claim = buildAnswerClaim({
      evidence: [evidence()],
      verification: verification({ layer_results: [{ layer: 'consistency', status: 'PASS', detail: 'no unresolved contradictions' }] }),
      contradicted: false,
      verificationHealth: HEALTHY,
    })
    expect(claim.verification_status).toBe('verified')
    expect(claim.source_type).toBe('tool_evidence')
    expect(claim.evidence).toHaveLength(1)
  })

  it('is "unverified_attempted" when evidence was gathered but every layer only SKIPPED (honest, not a fake PASS)', () => {
    const claim = buildAnswerClaim({
      evidence: [evidence()],
      verification: verification({ layer_results: [{ layer: 'goal_correctness', status: 'SKIPPED', detail: 'model-tier judgment' }] }),
      contradicted: false,
      verificationHealth: HEALTHY,
    })
    expect(claim.verification_status).toBe('unverified_attempted')
    expect(claim.source_type).toBe('tool_evidence')
  })

  it('is "contradicted" when the Contradiction layer flagged a conflict this turn, regardless of verification result', () => {
    const claim = buildAnswerClaim({
      evidence: [evidence()],
      verification: verification({ layer_results: [{ layer: 'consistency', status: 'PASS', detail: 'no unresolved contradictions' }] }),
      contradicted: true,
      verificationHealth: HEALTHY,
    })
    expect(claim.verification_status).toBe('contradicted')
  })

  it('is "no_evidence" when no real observation was gathered this turn — a plain-reasoning reply', () => {
    const claim = buildAnswerClaim({
      evidence: [],
      verification: null,
      contradicted: false,
      verificationHealth: HEALTHY,
    })
    expect(claim.verification_status).toBe('no_evidence')
    expect(claim.source_type).toBe('model_reasoning')
    expect(claim.freshness).toBeNull()
  })

  it('derives confidence as min(strength, feasibility) and freshness as the least-fresh evidence timestamp', () => {
    const claim = buildAnswerClaim({
      evidence: [
        evidence({ freshness: '2026-08-10T00:00:00.000Z' }),
        evidence({ id: 'ev-2', freshness: '2026-08-12T00:00:00.000Z' }),
      ],
      verification: verification({ layer_results: [{ layer: 'consistency', status: 'PASS', detail: 'ok' }] }),
      contradicted: false,
      verificationHealth: { strength: 0.8, feasibility: 0.3 },
    })
    expect(claim.confidence).toBe(0.3)
    expect(claim.freshness).toBe('2026-08-10T00:00:00.000Z')
  })

  it('does not report "verified" on a critical failure even if some layer PASSed', () => {
    const claim = buildAnswerClaim({
      evidence: [evidence()],
      verification: verification({
        has_critical_failure: true,
        layer_results: [
          { layer: 'consistency', status: 'PASS', detail: 'ok' },
          { layer: 'requirements', status: 'FAIL', detail: 'criterion stated, no result produced' },
        ],
      }),
      contradicted: false,
      verificationHealth: HEALTHY,
    })
    expect(claim.verification_status).toBe('unverified_attempted')
  })
})
