import type { ArticleMeta } from './article-model.js'
import { claimMarks, type MarkTone } from './article-marks.js'

/**
 * Everything the page shows inside the text, as pieces of the text with what applies to each: the tint of a claim's sentence (green, orange or
 * red), a dotted underline where an open comment sits, a dashed underline where a suggested change would go, and a mark on a heading whose section
 * needs review. Only styling that does not move the text is possible (the marks are drawn on a copy behind the text area), so detail is not shown
 * here: the box under the text and the line "Here:" say what is at the cursor. Pure; a decoration is drawn only where the stored text still
 * stands at the stored place, so text typed since the last save never gets a mark in the wrong place.
 */

export interface TextPiece {
  start: number
  end: number
  /** The worst claim tone over this piece, when it is inside a claim's sentence. */
  tone?: MarkTone
  claimId?: string
  claimStatus?: string
  commentIds: string[]
  suggestionIds: string[]
  reviewSectionId?: string
}

interface Range {
  start: number
  end: number
}

const WORSE: Record<MarkTone, number> = { ok: 0, tried: 1, look: 2, bad: 3 }

export function textPieces(meta: ArticleMeta, markdown: string): TextPiece[] {
  const marks = claimMarks(meta, markdown)
  const comments = meta.comments.filter((c) => c.state === 'open' && c.span && !c.outdated && markdown.slice(c.span.start, c.span.end) === c.span.quote && c.span.end > c.span.start)
  const suggestions = meta.suggestions.filter((s) => s.state === 'pending' && s.span.end > s.span.start && markdown.slice(s.span.start, s.span.end) === s.span.quote)
  const reviews: (Range & { id: string })[] = []
  for (const sec of meta.sections) {
    if (sec.review.state !== 'needs_review' || sec.level === 0) continue
    const lineEnd = markdown.indexOf('\n', sec.span.start)
    const end = lineEnd === -1 ? markdown.length : lineEnd
    if (markdown[sec.span.start] === '#' && markdown.slice(sec.span.start, end).includes(sec.heading.trim()) && end > sec.span.start) reviews.push({ start: sec.span.start, end, id: sec.id })
  }

  const cuts = new Set<number>()
  for (const r of [...marks, ...comments.map((c) => c.span as Range), ...suggestions.map((s) => s.span), ...reviews]) { cuts.add(r.start); cuts.add(r.end) }
  const points = [...cuts].sort((a, b) => a - b)
  const pieces: TextPiece[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const [start, end] = [points[i], points[i + 1]]
    const inside = (r: Range): boolean => r.start <= start && r.end >= end
    const claim = marks.filter(inside).sort((a, b) => WORSE[b.tone] - WORSE[a.tone])[0]
    const commentIds = comments.filter((c) => inside(c.span as Range)).map((c) => c.id)
    const suggestionIds = suggestions.filter((s) => inside(s.span)).map((s) => s.id)
    const review = reviews.find(inside)
    if (!claim && commentIds.length === 0 && suggestionIds.length === 0 && !review) continue
    pieces.push({ start, end, tone: claim?.tone, claimId: claim?.claimId, claimStatus: claim?.status, commentIds, suggestionIds, reviewSectionId: review?.id })
  }
  return pieces
}

const STATUS_WORDS: Record<string, string> = {
  supported: 'backed by its source',
  partly_supported: 'only partly backed',
  not_supported: 'not backed by its source',
  contradicted: 'contradicted by a source',
  none: 'needs a source',
  none_found: 'searched for, no source found',
  attached: 'has a source, not checked',
  not_checked: 'not checked yet',
  stale: 'its source changed, check again',
}

/** What applies at one place in the text, in a short line the page shows under it; undefined when nothing does. */
export function describeAt(pieces: readonly TextPiece[], position: number): string | undefined {
  const p = pieces.find((x) => x.start <= position && position < x.end) ?? pieces.find((x) => x.end === position)
  if (!p) return undefined
  const parts = [
    p.claimStatus && (STATUS_WORDS[p.claimStatus] ?? p.claimStatus.replace('_', ' ')),
    p.commentIds.length > 0 && `${p.commentIds.length} open comment${p.commentIds.length === 1 ? '' : 's'}`,
    p.suggestionIds.length > 0 && `${p.suggestionIds.length} suggested change${p.suggestionIds.length === 1 ? '' : 's'}`,
    p.reviewSectionId && 'this section needs review',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
