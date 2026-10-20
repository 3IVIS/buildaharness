import { sentenceAround } from './article-marks.js'

/**
 * Growing a selection by units of writing: a sentence, then the paragraph, then the section (a heading and everything under it, down to the next
 * heading of the same or a higher level), then the whole article. Each step is the next unit that strictly contains the current selection, so a
 * word, a sentence and several sentences all grow sensibly. Pure; the page keeps the earlier selections to shrink back. Units are found in the text
 * as it is now (not from saved sections), so they are right while the writer is typing.
 */

export type SelectionUnit = 'sentence' | 'paragraph' | 'section' | 'article'
export interface SelectionRange {
  start: number
  end: number
}

function trimmed(text: string, start: number, end: number): SelectionRange {
  let a = start
  let b = end
  while (a < b && /\s/.test(text[a])) a++
  while (b > a && /\s/.test(text[b - 1])) b--
  return { start: a, end: b }
}

function paragraphAround(text: string, start: number, end: number): SelectionRange {
  const before = text.lastIndexOf('\n\n', start - 1)
  const after = text.indexOf('\n\n', end)
  return trimmed(text, before === -1 ? 0 : before + 2, after === -1 ? text.length : after)
}

function headingLevel(line: string): number {
  let n = 0
  while (n < line.length && line[n] === '#') n++
  return n > 0 && n <= 6 && line[n] === ' ' ? n : 0
}

/** The section that holds `start`: from its heading line to just before the next heading of the same or a higher level. The text before the first heading is a section of its own. */
function sectionAround(text: string, start: number): SelectionRange {
  const lines: { at: number; level: number }[] = []
  let at = 0
  for (const line of text.split('\n')) {
    lines.push({ at, level: headingLevel(line) })
    at += line.length + 1
  }
  let from = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].level > 0 && lines[i].at <= start) from = i
  if (from === -1) {
    const first = lines.find((l) => l.level > 0)
    return trimmed(text, 0, first ? first.at : text.length)
  }
  const level = lines[from].level
  const next = lines.slice(from + 1).find((l) => l.level > 0 && l.level <= level)
  return trimmed(text, lines[from].at, next ? next.at : text.length)
}

function contains(outer: SelectionRange, inner: SelectionRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end && outer.end - outer.start > inner.end - inner.start
}

function unitCandidates(text: string, range: SelectionRange): { here: SelectionRange; candidates: { range: SelectionRange; unit: SelectionUnit }[] } {
  const lo = Math.max(0, Math.min(range.start, range.end, text.length))
  const hi = Math.min(text.length, Math.max(range.start, range.end))
  const first = sentenceAround(text, lo, Math.max(lo, hi))
  const last = sentenceAround(text, Math.max(lo, hi - 1), hi)
  return {
    here: { start: lo, end: hi },
    candidates: [
      { range: trimmed(text, first.start, Math.max(first.end, last.end)), unit: 'sentence' },
      { range: paragraphAround(text, lo, hi), unit: 'paragraph' },
      { range: sectionAround(text, lo), unit: 'section' },
      { range: trimmed(text, 0, text.length), unit: 'article' },
    ],
  }
}

/** The next larger unit around the selection, or undefined when the whole article is already selected. */
export function expandSelection(text: string, range: SelectionRange): { range: SelectionRange; unit: SelectionUnit } | undefined {
  const { here, candidates } = unitCandidates(text, range)
  return candidates.find((c) => c.range.end > c.range.start && contains(c.range, here))
}

/** The unit the selection is: a selection that is exactly a sentence, paragraph or section is that unit; a cursor or a phrase is the sentence around it; anything longer, the smallest unit that holds it. */
export function unitOfSelection(text: string, range: SelectionRange): { range: SelectionRange; unit: SelectionUnit } | undefined {
  const { here, candidates } = unitCandidates(text, range)
  const t = trimmed(text, here.start, here.end)
  return candidates.find((c) => c.range.end > c.range.start && c.range.start <= t.start && c.range.end >= t.end && (c.unit !== 'sentence' || !text.slice(c.range.start, c.range.end).includes('\n')) && (c.unit !== 'paragraph' || !text.slice(c.range.start, c.range.end).includes('\n\n')))
}
