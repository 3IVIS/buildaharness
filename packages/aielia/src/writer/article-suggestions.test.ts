import { describe, it, expect } from 'vitest'
import { createArticleMeta } from './article-model.js'
import { acceptSuggestion, proposeSuggestion, refreshSuggestions, rejectSuggestion } from './article-suggestions.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = 'The p99 was 18 ms. It is quick. Memory use is 40 MB.\n'
const meta0 = createArticleMeta('a1', 'T')
const propose = (meta = meta0, md = MD, quote = '18 ms', replacement = '41 ms') => {
  const r = proposeSuggestion(meta, md, { quote, replacement, reason: 're-run', by: 'assistant', now: NOW })
  if (!r.ok) throw new Error(r.reason)
  return r.meta
}

describe('suggestions', () => {
  it('records a suggestion without changing the text', () => {
    const r = proposeSuggestion(meta0, MD, { quote: '18 ms', replacement: '41 ms', reason: 're-run', by: 'assistant', now: NOW })
    expect(r.ok && r.markdown).toBe(MD)
    expect(r.ok && r.meta.suggestions[0]).toMatchObject({ id: 'sg1', state: 'pending', proposedBy: 'assistant', span: { start: 12, end: 17, quote: '18 ms' } })
    expect(proposeSuggestion(meta0, MD, { quote: 'not there', replacement: 'x', reason: 'r', by: 'writer', now: NOW })).toMatchObject({ ok: false })
    expect(proposeSuggestion(meta0, MD, { quote: '', replacement: 'x', reason: 'r', by: 'writer', now: NOW })).toMatchObject({ ok: false })
  })

  it('applies an accepted suggestion once, and shifts later pending suggestions with the text', () => {
    let meta = propose()
    meta = propose(meta, MD, '40 MB', '41 MB')
    const r = acceptSuggestion(meta, MD, 'sg1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.markdown).toBe('The p99 was 41 ms. It is quick. Memory use is 40 MB.\n')
    expect(r.meta.suggestions[0].state).toBe('accepted')
    const second = r.meta.suggestions[1]
    expect(r.markdown.slice(second.span.start, second.span.end)).toBe('40 MB')
    expect(acceptSuggestion(r.meta, r.markdown, 'sg1')).toMatchObject({ ok: false })
  })

  it('records the writer\'s own wording as edited-and-accepted', () => {
    const r = acceptSuggestion(propose(), MD, 'sg1', '41 milliseconds')
    expect(r.ok && r.markdown).toContain('41 milliseconds')
    expect(r.ok && r.meta.suggestions[0].state).toBe('edited_accepted')
  })

  it('goes stale when the text underneath changed, and cannot be accepted as it stands', () => {
    const meta = propose()
    const edited = MD.replace('18 ms', '20 ms')
    expect(acceptSuggestion(meta, edited, 'sg1')).toMatchObject({ ok: false })
    expect(refreshSuggestions(meta, edited).suggestions[0].state).toBe('stale')
  })

  it('follows its text when it moves, and a suggestion that overlaps an accepted edit goes stale', () => {
    const meta = propose()
    const moved = 'Intro added.\n' + MD
    const refreshed = refreshSuggestions(meta, moved)
    expect(moved.slice(refreshed.suggestions[0].span.start, refreshed.suggestions[0].span.end)).toBe('18 ms')
    let m = propose(meta0, MD, 'p99 was 18 ms', 'p99 was 41 ms')
    m = propose(m, MD, '18 ms', '19 ms')
    const r = acceptSuggestion(m, MD, 'sg1')
    expect(r.ok && r.meta.suggestions[1].state).toBe('stale')
  })

  it('rejects once, and not unknown or finished ones; never touches the text', () => {
    const meta = propose()
    const r = rejectSuggestion(meta, 'sg1')
    expect(r.ok && r.meta.suggestions[0].state).toBe('rejected')
    expect(rejectSuggestion(r.ok ? r.meta : meta, 'sg1')).toMatchObject({ ok: false })
    expect(rejectSuggestion(meta, 'nope')).toMatchObject({ ok: false })
    expect(meta.suggestions[0].state).toBe('pending')
  })
})
