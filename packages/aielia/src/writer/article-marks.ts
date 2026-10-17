import type { ArticleMeta } from './article-model.js'
import { effectiveSourceStatus } from './article-rules.js'
import { currentLookup } from './article-verify.js'

/**
 * Where the page underlines factual claims in the text, and in which of three tones. Pure: a claim is marked only where its stored
 * quote still stands at its stored position in the text on screen, so text typed since the last save never gets a mark in the wrong place.
 * Marks never overlap (the earlier claim wins).
 */

export type MarkTone = 'ok' | 'look' | 'bad'

export interface ClaimMark {
  start: number
  end: number
  claimId: string
  tone: MarkTone
  /** The status shown to the writer, after the rules for stale and unchecked results. */
  status: string
}

export function claimMarks(meta: ArticleMeta, markdown: string): ClaimMark[] {
  const marks: ClaimMark[] = []
  let last = 0
  for (const c of [...meta.claims].filter((x) => x.kind === 'factual').sort((a, b) => a.position - b.position)) {
    const end = c.position + c.quote.length
    if (c.position < last || c.quote.length === 0 || markdown.slice(c.position, end) !== c.quote) continue
    const status = effectiveSourceStatus(c, meta.sources)
    // A claim that was searched for and not backed is shown as not supported, not as merely unchecked.
    const searchedNone = status === 'none' && currentLookup(c)?.outcome !== undefined && currentLookup(c)?.outcome !== 'unavailable'
    const tone: MarkTone = searchedNone ? 'bad' : status === 'supported' && !c.needsRecheck ? 'ok' : status === 'not_supported' || status === 'contradicted' ? 'bad' : 'look'
    marks.push({ start: c.position, end, claimId: c.id, tone, status: searchedNone ? 'none_found' : status })
    last = end
  }
  return marks
}
