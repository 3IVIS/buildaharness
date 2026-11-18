import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ProbablySpam } from './ProbablySpam'
import { createSampleMailbox } from './sample-mode'

afterEach(() => { cleanup() })
const items = [{ threadId: 't1', subject: 'You won', sender: 'prize@example.net', reason: 'Fills your Junk folder.' }, { threadId: 't2', subject: 'Verify now', sender: 'x@example.net', reason: 'Spoofed sender.' }]

describe('ProbablySpam', () => {
  it('shows nothing when there is nothing', () => {
    const { container } = render(<ProbablySpam items={[]} onMoveAll={vi.fn()} onNotSpam={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
  it('counts the items, asks to move them all, and lets each be called not spam, with the reason shown', () => {
    const onMoveAll = vi.fn(), onNotSpam = vi.fn()
    render(<ProbablySpam items={items} onMoveAll={onMoveAll} onNotSpam={onNotSpam} />)
    expect(screen.getByText('2 probably spam')).toBeTruthy()
    expect(screen.getByText('Fills your Junk folder.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move to Junk' }))
    expect(onMoveAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Not spam: You won' }))
    expect(onNotSpam).toHaveBeenCalledWith('t1')
  })
})

describe('sample mailbox spam', () => {
  it('has a Junk folder and finds the spoofed-sender mail as probably spam, without a model', async () => {
    const s = await createSampleMailbox()
    expect(s.folders.some((f) => f.kind === 'junk')).toBe(true)
    expect(s.spam.length).toBeGreaterThan(0)
    for (const i of s.spam) expect(i.reason).toMatch(/Sample mailbox/)
  })
})
