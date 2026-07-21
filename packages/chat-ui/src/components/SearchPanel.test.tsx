import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TranscriptSearchHit } from '@buildaharness/personal-assistant'
import { SearchPanel } from './SearchPanel'

const HITS: TranscriptSearchHit[] = [
  { sessionId: 'session-aaaaaaaa-1111', role: 'user', content: 'remind me to water the garden tomorrow', at: '2026-07-01T10:00:00.000Z', score: 1 },
  { sessionId: 'session-bbbbbbbb-2222', role: 'assistant', content: 'Sure — I set a reminder about the garden for tomorrow morning.', at: '2026-07-01T10:00:05.000Z', score: 0.6 },
]

describe('SearchPanel', () => {
  it('submitting a query with matches renders each hit, ranked in the order returned by search()', async () => {
    const user = userEvent.setup()
    const search = vi.fn(async () => HITS)
    render(<SearchPanel search={search} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('Search past messages'), 'garden')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(search).toHaveBeenCalledWith('garden')
    const rows = await screen.findAllByRole('button', { name: /garden/i })
    expect(rows).toHaveLength(2)
    // Order preserved as returned (the ranking itself is scoring.ts's job, already tested there).
    expect(rows[0]).toHaveTextContent('water the garden tomorrow')
    expect(rows[1]).toHaveTextContent('reminder about the garden')
  })

  it('highlights matched query terms within a result', async () => {
    const user = userEvent.setup()
    const search = vi.fn(async () => [HITS[0]])
    render(<SearchPanel search={search} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('Search past messages'), 'garden')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    const marks = await screen.findAllByText('garden', { selector: 'mark' })
    expect(marks.length).toBeGreaterThan(0)
  })

  it('a query with no matches shows a clear empty state', async () => {
    const user = userEvent.setup()
    const search = vi.fn(async () => [])
    render(<SearchPanel search={search} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('Search past messages'), 'nonexistent-term')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('No results for "nonexistent-term".')).toBeInTheDocument()
  })

  it('clicking a result expands it to show the full, untruncated content', async () => {
    const user = userEvent.setup()
    const longContent = `remind me to water the garden tomorrow ${'and also do many other things '.repeat(10)}`.trim()
    const search = vi.fn(async () => [{ ...HITS[0], content: longContent }])
    const { container } = render(<SearchPanel search={search} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('Search past messages'), 'garden')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    const row = await screen.findByRole('button', { name: /garden/i })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.search-panel__result-detail')).not.toBeInTheDocument()

    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    // Highlighting splits the content across several <mark>/<span> nodes, so assert on the
    // detail block's aggregate text rather than a single getByText match.
    expect(container.querySelector('.search-panel__result-detail')?.textContent).toBe(longContent)

    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('.search-panel__result-detail')).not.toBeInTheDocument()
  })

  it('"Back" calls onCancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<SearchPanel search={vi.fn(async () => [])} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('the Search button is disabled with an empty/whitespace-only query', async () => {
    const user = userEvent.setup()
    render(<SearchPanel search={vi.fn(async () => [])} onCancel={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
    await user.type(screen.getByLabelText('Search past messages'), '   ')
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled()
  })
})
