import { parseSections } from './article-sections.js'
import { textUnitAt } from './article-source-links.js'

/**
 * When the page should save a version by itself while the writer types: a sentence has been finished (a full stop, question mark or
 * exclamation mark ends it), a section has been started (a heading line is complete), or the writer has begun changing a different sentence
 * from the one they were editing, which means they are done with that one. Pure: it looks at the text before and after one change.
 */

export interface AutosaveStep {
  /** `after`: save the text as it is now. `before`: save the text as it was before this change, which is how the sentence stood when the writer left it. */
  moment: 'before' | 'after' | null
  /** Where the sentence being edited starts, to hand back with the next change. */
  sentenceStart: number | null
}

const completedHeadings = (text: string): number => parseSections(text).filter((h) => h.level > 0 && text.indexOf('\n', h.start) !== -1).length
const sentenceEnds = (text: string): number => (text.match(/[.!?](?=\s|$)/g) ?? []).length

export function autosaveStep(prev: string, next: string, lastSentenceStart: number | null): AutosaveStep {
  if (prev === next) return { moment: null, sentenceStart: lastSentenceStart }
  let p = 0
  const max = Math.min(prev.length, next.length)
  while (p < max && prev[p] === next[p]) p++
  const sentenceStart = textUnitAt(next, p)?.start ?? null
  if (completedHeadings(next) > completedHeadings(prev)) return { moment: 'after', sentenceStart }
  if (sentenceEnds(next) > sentenceEnds(prev)) return { moment: 'after', sentenceStart }
  const was = textUnitAt(prev, p)?.start ?? null
  if (was !== null && lastSentenceStart !== null && was !== lastSentenceStart) return { moment: 'before', sentenceStart }
  return { moment: null, sentenceStart }
}
