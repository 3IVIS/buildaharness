import { currentLookup } from './article-verify.js'
import type { ArticleMeta, Claim } from './article-model.js'
import { effectiveSourceStatus } from './article-rules.js'
import { sourcesForClaim } from './article-support.js'

/**
 * Issues in batches. Everything that needs the writer's attention is grouped by what it is, so it can be dealt with one category at a time
 * or all together. This module only decides which items belong to which category (from the article's own records, no language judgement);
 * the service runs the batch actions.
 *
 *  suggestions   suggested changes waiting for Accept or Reject
 *  comments      open reviewer comments the writer can act on (comments in conflict are listed apart: they need the writer's choice)
 *  checkable     factual claims with a stored source passage that have not been checked, or whose check no longer applies
 *  unsupported   factual claims with no source, or that their source does not support
 *  sections      sections marked as needing review
 *  links         links Aielia proposed (between sections, and between claims and sources) that wait for the writer
 *  stale         suggestions that can no longer be applied because the text under them changed
 */

export type IssueCategory = 'suggestions' | 'comments' | 'checkable' | 'unsupported' | 'sections' | 'links' | 'stale'

export interface IssueItem {
  id: string
  label: string
  detail?: string
}

export interface IssueBatch {
  category: IssueCategory
  title: string
  items: IssueItem[]
  /** Open comments that conflict with each other. Not part of any batch action. */
  needsYourChoice?: IssueItem[]
}

const CATEGORY_TITLE: Record<IssueCategory, string> = {
  suggestions: 'Suggested changes',
  comments: 'Reviewer comments',
  checkable: 'Claims to check',
  unsupported: 'Claims without support',
  sections: 'Sections to review',
  links: 'Links to confirm',
  stale: 'Suggestions that no longer fit',
}

export const ISSUE_CATEGORIES: IssueCategory[] = ['suggestions', 'comments', 'checkable', 'unsupported', 'sections', 'links', 'stale']

const clip = (t: string, n = 90): string => (t.length > n ? `${t.slice(0, n)}…` : t)

/** The factual claims that can be checked right now: a stored passage is attached and nothing valid has been said about the claim yet. */
export function checkableClaims(meta: ArticleMeta): Claim[] {
  return meta.claims.filter((c) => {
    if (c.kind !== 'factual') return false
    const withPassage = sourcesForClaim(meta, c.id).some((s) => s.passage?.trim())
    if (!withPassage) return false
    const status = effectiveSourceStatus(c, meta.sources)
    return status === 'attached' || status === 'not_checked' || status === 'stale' || c.needsRecheck === true
  })
}

/** The factual claims that are not backed and cannot be checked now: no source, a source with no passage to read, or a source that does not support them. */
export function unsupportedClaims(meta: ArticleMeta): Claim[] {
  const checkable = new Set(checkableClaims(meta).map((c) => c.id))
  return meta.claims.filter((c) => c.kind === 'factual' && !checkable.has(c.id) && effectiveSourceStatus(c, meta.sources) !== 'supported')
}

function unsupportedDetail(meta: ArticleMeta, c: Claim): string {
  const status = effectiveSourceStatus(c, meta.sources)
  if (status === 'none') return currentLookup(c) && currentLookup(c)?.outcome !== 'unavailable' ? 'no source found when searched' : 'no source'
  if (status === 'attached' || status === 'not_checked' || status === 'stale') return 'no passage to check against'
  return status.replace('_', ' ')
}

export function collectIssues(meta: ArticleMeta): IssueBatch[] {
  const open = meta.comments.filter((c) => c.state === 'open')
  const sectionName = (id: string): string => meta.sections.find((s) => s.id === id)?.heading || '(opening)'
  const proposedSectionLinks = meta.links.filter((l) => l.origin === 'proposed' && l.from.type === 'section')
  const proposedSourceLinks = meta.links.filter((l) => l.origin === 'proposed' && l.kind === 'supported_by')
  const all: IssueBatch[] = [
    { category: 'suggestions', title: CATEGORY_TITLE.suggestions, items: meta.suggestions.filter((s) => s.state === 'pending').map((s) => ({ id: s.id, label: clip(`${s.span.quote} → ${s.replacement}`), detail: s.reason })) },
    {
      category: 'comments',
      title: CATEGORY_TITLE.comments,
      items: open.filter((c) => c.conflictsWith.length === 0).map((c) => ({ id: c.id, label: `${c.label ?? c.id}: ${clip(c.text)}`, detail: c.decision })),
      needsYourChoice: open.filter((c) => c.conflictsWith.length > 0).map((c) => ({ id: c.id, label: `${c.label ?? c.id}: ${clip(c.text)}` })),
    },
    { category: 'checkable', title: CATEGORY_TITLE.checkable, items: checkableClaims(meta).map((c) => ({ id: c.id, label: clip(c.quote) })) },
    { category: 'unsupported', title: CATEGORY_TITLE.unsupported, items: unsupportedClaims(meta).map((c) => ({ id: c.id, label: clip(c.quote), detail: unsupportedDetail(meta, c) })) },
    { category: 'sections', title: CATEGORY_TITLE.sections, items: meta.sections.filter((s) => s.review.state === 'needs_review').map((s) => ({ id: s.id, label: sectionName(s.id), detail: s.review.reason })) },
    {
      category: 'links',
      title: CATEGORY_TITLE.links,
      items: [
        ...proposedSectionLinks.map((l) => ({ id: l.id, label: `${sectionName(l.from.id)} ${l.kind === 'repeats' ? 'repeats' : 'rests on'} ${sectionName(l.to.id)}`, detail: l.reason })),
        ...proposedSourceLinks.map((l) => ({ id: l.id, label: `A source for: ${clip(meta.claims.find((c) => c.id === l.from.id)?.quote ?? l.from.id, 60)}`, detail: l.reason })),
      ],
    },
    { category: 'stale', title: CATEGORY_TITLE.stale, items: meta.suggestions.filter((s) => s.state === 'stale').map((s) => ({ id: s.id, label: clip(`${s.span.quote} → ${s.replacement}`) })) },
  ]
  return all.filter((b) => b.items.length > 0 || (b.needsYourChoice?.length ?? 0) > 0)
}

export function issueCount(batches: readonly IssueBatch[]): number {
  return batches.reduce((n, b) => n + b.items.length + (b.needsYourChoice?.length ?? 0), 0)
}

/**
 * What is left before the article is ready, as plain lines for the answering model, so "what is left?" is answered from the article's own
 * records and not from a guess. At most a few items per group; empty when nothing is open.
 */
export function renderIssuesForChat(meta: ArticleMeta, perGroup = 15): string {
  const lines: string[] = []
  for (const batch of collectIssues(meta)) {
    if (batch.items.length === 0 && !batch.needsYourChoice?.length) continue
    lines.push(`${batch.title} (${batch.items.length + (batch.needsYourChoice?.length ?? 0)}):`)
    for (const i of batch.items.slice(0, perGroup)) lines.push(`- ${i.label}${i.detail ? ` — ${i.detail}` : ''}`)
    if (batch.items.length > perGroup) lines.push(`- … and ${batch.items.length - perGroup} more that are open but not listed here`)
    for (const i of (batch.needsYourChoice ?? []).slice(0, perGroup)) lines.push(`- needs the writer's choice: ${i.label}${i.detail ? ` — ${i.detail}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * The article's records cut down to what bears on one piece of text, so `collectIssues` on the result lists only the issues there: suggestions and
 * comments on that text, claims in it, and the section it is in (with the links that start from that section or from a claim in the text).
 */
export function issuesInRange(meta: ArticleMeta, range: { start: number; end: number }): ArticleMeta {
  const touches = (a: { start: number; end: number }): boolean => a.start < Math.max(range.end, range.start + 1) && range.start < Math.max(a.end, a.start + 1)
  const claims = meta.claims.filter((c) => touches({ start: c.position, end: c.position + c.quote.length }))
  const sections = meta.sections.filter((s) => touches(s.span))
  return {
    ...meta,
    suggestions: meta.suggestions.filter((s) => touches(s.span)),
    comments: meta.comments.filter((c) => c.span && touches(c.span)),
    claims,
    sections,
    links: meta.links.filter((l) => (l.from.type === 'section' && sections.some((s) => s.id === l.from.id)) || (l.from.type === 'claim' && claims.some((c) => c.id === l.from.id))),
    corrections: [],
  }
}
