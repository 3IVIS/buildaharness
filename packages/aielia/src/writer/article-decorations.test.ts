import { describe, it, expect } from 'vitest'
import { createArticleMeta, type Claim } from './article-model.js'
import { reconcileSections } from './article-sections.js'
import { describeAt, textPieces } from './article-decorations.js'

const MD = '# Post\n\nThe p99 was 18 ms. It is quick.\n\n## Latency\n\nNothing else here.\n'
const base = () => ({ ...createArticleMeta('a1', 'Post'), sections: reconcileSections([], MD, (t: ReadonlySet<string>) => `s${t.size + 1}`).sections })
const claim = (id: string, quote: string, extra: Partial<Claim> = {}): Claim => ({ id, sectionId: 's1', quote, position: MD.indexOf(quote), kind: 'factual', author: 'model', authorAt: 'x', confirmed: false, sourceStatus: 'none', ...extra }) as Claim
const at = (s: string): { start: number; end: number; quote: string } => ({ start: MD.indexOf(s), end: MD.indexOf(s) + s.length, quote: s })

describe('what is shown inside the text', () => {
  it('layers a claim tint, an open comment and a pending suggestion, and says what is at the cursor', () => {
    const meta = {
      ...base(),
      claims: [claim('c1', 'The p99 was 18 ms.')],
      comments: [{ id: 'wc1', articleId: 'a1', text: 'check', state: 'open' as const, conflictsWith: [], origin: 'reviewer' as const, capturedAt: 'x', span: at('18 ms') }, { id: 'wc2', articleId: 'a1', text: 'done', state: 'addressed' as const, conflictsWith: [], origin: 'reviewer' as const, capturedAt: 'x', span: at('quick') }],
      suggestions: [{ id: 'sg1', span: at('It is quick.'), replacement: 'It is fast.', reason: 'r', proposedBy: 'assistant' as const, state: 'pending' as const }] as never,
    }
    const pieces = textPieces(meta, MD)
    const inComment = pieces.find((p) => p.commentIds.includes('wc1'))!
    expect(MD.slice(inComment.start, inComment.end)).toBe('18 ms')
    expect(inComment.tone).toBe('look')
    expect(pieces.some((p) => p.commentIds.includes('wc2'))).toBe(false)
    expect(MD.slice(...(([p]) => [p.start, p.end] as const)(pieces.filter((p) => p.suggestionIds.includes('sg1'))))).toBe('It is quick.')
    expect(describeAt(pieces, MD.indexOf('18 ms'))).toBe('needs a source · 1 open comment')
    expect(describeAt(pieces, MD.indexOf('Nothing'))).toBeUndefined()
  })
  it('marks the heading of a section that needs review, and only where the heading still stands', () => {
    const m = base()
    const meta = { ...m, sections: m.sections.map((s) => (s.heading === 'Latency' ? { ...s, review: { state: 'needs_review' as const, reason: 'figure changed', setBy: 'resolver' as const } } : s)) }
    const [p] = textPieces(meta, MD)
    expect(MD.slice(p.start, p.end)).toBe('## Latency')
    expect(describeAt([p], p.start)).toBe('this section needs review')
    expect(textPieces(meta, MD.replace('## Latency', '## Speed'))).toEqual([])
  })
  it('draws nothing for a comment or suggestion whose text has moved, or has been dealt with', () => {
    const meta = { ...base(), comments: [{ id: 'wc1', articleId: 'a1', text: 't', state: 'open' as const, conflictsWith: [], origin: 'reviewer' as const, capturedAt: 'x', span: at('18 ms') }], suggestions: [{ id: 'sg1', span: at('quick'), replacement: 'x', reason: 'r', proposedBy: 'assistant' as const, state: 'accepted' as const }] as never }
    expect(textPieces(meta, MD.replace('18 ms', '19 ms'))).toEqual([])
    expect(textPieces(meta, MD).map((p) => p.suggestionIds)).toEqual([[]])
  })
})
