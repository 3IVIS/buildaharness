import { describe, it, expect } from 'vitest'
import { createArticleMeta, type ArticleMeta } from './article-model.js'
import { addCommentOnText, commentsInRange, refreshComments } from './article-comments.js'

const NOW = '2026-10-16T10:00:00.000Z'
const MD = '# Post\n\n## Latency\n\nThe p99 was 18 ms. It is quick.\n\n## Memory\n\nIt uses 40 MB.\n'
const meta = (): ArticleMeta => createArticleMeta('a1', 'Post')
const at = (s: string): number => MD.indexOf(s)

describe('comments on text', () => {
  it('anchors a comment to the sentence at the cursor, or to what was highlighted', () => {
    const a = addCommentOnText(meta(), MD, { start: at('18 ms'), end: at('18 ms') }, '  Is this the median?  ', NOW)
    expect(a.ok && a.comment).toMatchObject({ text: 'Is this the median?', state: 'open', origin: 'writer', span: { quote: 'The p99 was 18 ms.' } })
    if (!a.ok) return
    const para = MD.slice(at('The p99'), at('It is quick.') + 'It is quick.'.length)
    const b = addCommentOnText(a.meta, MD, { start: at('The p99'), end: at('It is quick.') + 12 }, 'Tighten this paragraph', NOW)
    expect(b.ok && b.comment.span?.quote).toBe(para)
    expect(b.ok && b.comment.id).toBe('wc2')
  })
  it('refuses empty text and a click with nothing under it', () => {
    expect(addCommentOnText(meta(), MD, { start: at('18 ms'), end: at('18 ms') }, '   ', NOW)).toMatchObject({ ok: false })
    expect(addCommentOnText(meta(), '   ', { start: 1, end: 1 }, 'hello', NOW)).toMatchObject({ ok: false })
  })
  it('finds the comments for the text under the cursor, and not those without text of their own', () => {
    let m = meta()
    const a = addCommentOnText(m, MD, { start: at('18 ms'), end: at('18 ms') }, 'one', NOW)
    if (!a.ok) throw new Error('setup')
    m = { ...a.meta, comments: [...a.meta.comments, { id: 'wc9', articleId: 'a1', text: 'from chat', state: 'open', conflictsWith: [], origin: 'reviewer', capturedAt: NOW }] }
    expect(commentsInRange(m, { start: at('18 ms'), end: at('18 ms') + 1 }).map((c) => c.id)).toEqual(['wc1'])
    expect(commentsInRange(m, { start: at('40 MB'), end: at('40 MB') + 1 })).toEqual([])
  })
  it('follows the text through an edit, and keeps the comment, marked outdated, when the text is gone', () => {
    const a = addCommentOnText(meta(), MD, { start: at('18 ms'), end: at('18 ms') }, 'one', NOW)
    if (!a.ok) throw new Error('setup')
    const moved = 'Intro added.\n\n' + MD
    const r1 = refreshComments(a.meta, moved)
    expect(moved.slice(r1.comments[0].span!.start, r1.comments[0].span!.end)).toBe('The p99 was 18 ms.')
    expect(r1.comments[0].outdated).toBeUndefined()
    const r2 = refreshComments(a.meta, MD.replace('18 ms', '41 ms'))
    expect(r2.comments[0]).toMatchObject({ outdated: true, text: 'one' })
    expect(commentsInRange(r2, { start: 0, end: MD.length })).toEqual([])
    const back = refreshComments(r2, MD) // the text came back (an undo): the comment is current again
    expect(back.comments[0].outdated).toBeUndefined()
  })
  it('does not change a meta that has no commented text', () => {
    const m = meta()
    expect(refreshComments(m, MD)).toBe(m)
  })
})
