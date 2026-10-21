import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ArticleMeta } from '@buildaharness/aielia'
import { SourcesPanel, codeLinesOf, groupSources } from './SourcesPanel'

const src = (id: string, over: object = {}) => ({ id, kind: 'code', address: 'o/r/src/limiter.ts', passage: 'ctx a\nctx b\nctx c\nconst LIMIT = 100\nctx d', note: 'Found in r for this claim (lines 4-4).', trust: 'normal', freshness: 'current', ...over })
const claim = (id: string, quote: string, position: number) => ({ id, sectionId: 's1', quote, position, kind: 'factual', author: 'model', authorAt: '', confirmed: false, sourceStatus: 'supported' })
const link = (id: string, c: string, s: string) => ({ id, from: { type: 'claim', id: c }, to: { type: 'source', id: s }, kind: 'supported_by', origin: 'drawn', at: '' })
const meta = {
  sources: [src('a'), src('b', { passage: 'x\ny\nz\nother()', note: 'Found in r for this claim (lines 4-4).' }), src('c', { address: 'o/r/README.md' })],
  claims: [claim('k1', 'The limit is 100.', 5), claim('k2', 'It is fast.', 40)],
  links: [link('l1', 'k1', 'a'), link('l2', 'k2', 'b'), link('l3', 'k1', 'b')],
} as unknown as ArticleMeta

describe('SourcesPanel by file', () => {
  it('groups the sources of one file and counts the different claims it backs', () => {
    const groups = groupSources(meta)
    expect(groups.map((g) => [g.address, g.claimCount, g.mappings.length])).toEqual([['o/r/src/limiter.ts', 2, 3], ['o/r/README.md', 0, 0]])
  })
  it('keeps only the lines the note names, not the context around them', () => {
    expect(codeLinesOf(meta.sources[0])).toEqual({ from: 4, to: 4, text: 'const LIMIT = 100' })
  })
  it('shows a collapsed count; opening it lists the code line and the claim it backs, and the claim jumps to the text', async () => {
    const onJump = vi.fn()
    render(<SourcesPanel meta={meta} busy={false} onJump={onJump} onRead={vi.fn()} onAcceptNew={vi.fn()} />)
    expect(screen.queryByText('const LIMIT = 100')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '2 claims' }))
    expect(screen.getByText('const LIMIT = 100')).toBeTruthy()
    await userEvent.click(screen.getAllByRole('button', { name: 'It is fast.' })[0])
    expect(onJump).toHaveBeenCalledWith(40)
  })
})
