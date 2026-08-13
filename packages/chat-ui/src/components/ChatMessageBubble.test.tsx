import { describe, it, expect } from 'vitest'
import type { AnswerClaim } from '@buildaharness/personal-assistant'
import { answerClaimLabel } from './ChatMessageBubble'

function claim(verification_status: AnswerClaim['verification_status']): AnswerClaim {
  return {
    evidence: [],
    confidence: 0.5,
    freshness: null,
    source_type: 'model_reasoning',
    verification_status,
  }
}

// Golden-output test: pins the exact phrasing difference between "this is true" and "I found X
// but couldn't independently verify it" so a future change can't silently collapse the four
// branches back into one generic phrasing (Phase 6 of the harness/assistant remediation plan).
describe('answerClaimLabel', () => {
  it('renders distinct, non-overlapping phrasing for each verification_status branch', () => {
    expect(answerClaimLabel(claim('verified'))).toBe(
      'This is true — grounded in evidence that was independently verified.',
    )
    expect(answerClaimLabel(claim('unverified_attempted'))).toBe(
      "I found evidence for this, but couldn't independently verify it.",
    )
    expect(answerClaimLabel(claim('contradicted'))).toBe(
      'This conflicts with something I already believe — worth double-checking.',
    )
    expect(answerClaimLabel(claim('no_evidence'))).toBe(
      'This is my own reasoning, not backed by anything I looked up.',
    )
  })

  it('never lets "verified" and "unverified_attempted" collapse to the same phrasing', () => {
    expect(answerClaimLabel(claim('verified'))).not.toBe(answerClaimLabel(claim('unverified_attempted')))
  })
})
