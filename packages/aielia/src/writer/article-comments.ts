import type { ArticleMeta } from './article-model.js'
import type { WriterComment } from './writer-chat-state.js'
import { textUnitAt, type TextRange } from './article-source-links.js'

/**
 * Comments the writer makes on text: highlight a phrase, a sentence, a paragraph or a section, and type. The comment keeps the quoted text; when
 * the article changes it is found again by that quote, and if the text is gone the comment is kept and marked as outdated, never dropped.
 */

export type CommentResult = { ok: true; meta: ArticleMeta; comment: WriterComment } | { ok: false; reason: string }

function nextId(meta: ArticleMeta): string {
  let n = meta.comments.length + 1
  while (meta.comments.some((c) => c.id === `wc${n}`)) n++
  return `wc${n}`
}

export function addCommentOnText(meta: ArticleMeta, markdown: string, range: TextRange, text: string, now: string): CommentResult {
  const body = text.trim()
  if (!body) return { ok: false, reason: 'A comment needs some text.' }
  const unit = textUnitAt(markdown, range.start, range.end)
  if (!unit) return { ok: false, reason: 'Click in the text, or highlight what the comment is about.' }
  const comment: WriterComment = { id: nextId(meta), articleId: meta.id, text: body, state: 'open', conflictsWith: [], origin: 'writer', span: { start: unit.start, end: unit.end, quote: unit.quote }, capturedAt: now }
  return { ok: true, comment, meta: { ...meta, comments: [...meta.comments, comment] } }
}

/** Comments whose text overlaps the range. Comments that arrived from chat have no text of their own and are not here. */
export function commentsInRange(meta: ArticleMeta, range: TextRange): WriterComment[] {
  return meta.comments.filter((c) => c.span && !c.outdated && c.span.start < range.end && c.span.end > range.start)
}

function nearest(markdown: string, quote: string, hint: number): number {
  let best = -1
  let at = markdown.indexOf(quote)
  while (at !== -1) {
    if (best === -1 || Math.abs(at - hint) < Math.abs(best - hint)) best = at
    at = markdown.indexOf(quote, at + 1)
  }
  return best
}

/** Follows each comment's text through an edit; a comment whose text is gone is marked outdated (and keeps its words). */
export function refreshComments(meta: ArticleMeta, markdown: string): ArticleMeta {
  if (!meta.comments.some((c) => c.span)) return meta
  const comments = meta.comments.map((c) => {
    if (!c.span) return c
    const at = nearest(markdown, c.span.quote, c.span.start)
    if (at === -1) return c.outdated ? c : { ...c, outdated: true }
    return at === c.span.start && !c.outdated ? c : { ...c, outdated: undefined, span: { ...c.span, start: at, end: at + c.span.quote.length } }
  })
  return { ...meta, comments }
}
