import type { ArticleMeta } from './article-model.js'
import { effectiveSourceStatus } from './article-rules.js'
import { currentLookup } from './article-verify.js'

/**
 * Where the page tints the text, and in which of three tones. Pure: a claim is marked only where its stored quote still stands at its stored
 * position in the text on screen, so text typed since the last save never gets a tint in the wrong place. The tint covers the whole sentence that
 * holds the claim. Two claims in one sentence share one tint, in the worse tone. Marks never overlap.
 *
 * ok (green): the claim is backed by its source. look (orange): it still needs a source, a check, or a better source (no source, not checked yet,
 * out of date, partly or not backed, or searched for and not found). bad (red): a source says the opposite.
 */

export type MarkTone = 'ok' | 'tried' | 'look' | 'bad'

export interface ClaimMark {
  /** The sentence the tint covers. */
  start: number
  end: number
  claimId: string
  tone: MarkTone
  /** The status shown to the writer, after the rules for stale and unchecked results. */
  status: string
}

const SENTENCE_END = new Set(['.', '!', '?'])
const WORSE: Record<MarkTone, number> = { ok: 0, tried: 1, look: 2, bad: 3 }

/** The sentence around a quote: back to the end of the previous sentence or the start of the line, forward to the end punctuation or the end of the line. */
export function sentenceAround(text: string, start: number, end: number): { start: number; end: number } {
  let s = start
  while (s > 0 && text[s - 1] !== '\n' && !(SENTENCE_END.has(text[s - 1]) && /\s/.test(text[s] ?? ''))) s--
  // A list bullet, quote mark or heading hash at the start of the line is not part of the sentence.
  while (s < start && (/\s/.test(text[s]) || '-*+>#'.includes(text[s]))) s++
  let e = end
  while (e < text.length && text[e] !== '\n' && !(SENTENCE_END.has(text[e - 1]) && (e === text.length || /\s/.test(text[e])))) e++
  return { start: s, end: e }
}

export function claimMarks(meta: ArticleMeta, markdown: string): ClaimMark[] {
  const marks: ClaimMark[] = []
  for (const c of [...meta.claims].filter((x) => x.kind === 'factual').sort((a, b) => a.position - b.position)) {
    const end = c.position + c.quote.length
    if (c.quote.length === 0 || markdown.slice(c.position, end) !== c.quote) continue
    const status = effectiveSourceStatus(c, meta.sources)
    // A claim that was searched for and not backed has its own status; it still needs a source, so it is orange, not red.
    const searchedNone = status === 'none' && currentLookup(c)?.outcome !== undefined && currentLookup(c)?.outcome !== 'unavailable'
    // 'tried': looked for and nothing found. Still unbacked, but not the same as a claim nobody has looked at.
    const tone: MarkTone = status === 'contradicted' ? 'bad' : status === 'supported' && !c.needsRecheck ? 'ok' : searchedNone ? 'tried' : 'look'
    const shown = searchedNone ? 'none_found' : status
    const sentence = sentenceAround(markdown, c.position, end)
    const prev = marks[marks.length - 1]
    if (prev && sentence.start < prev.end) {
      // Same sentence as the mark before: one tint, in the worse tone.
      prev.end = Math.max(prev.end, sentence.end)
      if (WORSE[tone] > WORSE[prev.tone]) { prev.tone = tone; prev.status = shown }
      continue
    }
    marks.push({ start: sentence.start, end: sentence.end, claimId: c.id, tone, status: shown })
  }
  return marks
}
