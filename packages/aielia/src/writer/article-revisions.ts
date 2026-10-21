import { sentenceAround } from './article-marks.js'
import { unitOfSelection, type SelectionRange, type SelectionUnit } from './article-selection.js'

/**
 * The revisions of one piece of the text (a sentence, a paragraph or a section): how that piece read in each saved version. The piece is the unit
 * the selection is (see `unitOfSelection`). In an older version the same piece is the unit of the same kind that shares the most words with it, so
 * a reworded sentence is still found; when nothing shares enough, the piece was not in that version. Pure; versions come from the article's snapshots.
 */

export interface VersionText {
  index: number
  kind: string
  label?: string
  at: string
  markdown: string
}

export interface TextRevision {
  /** The version, or undefined for the text as it is now. */
  index?: number
  kind?: string
  label?: string
  at?: string
  /** How the piece read then; undefined when it was not in that version. */
  text: string | undefined
}

export interface TextRevisions {
  unit: SelectionUnit
  now: string
  /** Newest first, starting with now, and only where the wording differs from the revision before it. */
  revisions: TextRevision[]
}

/** How much of its words a sentence must share with the one it is compared with. Lower finds more rewordings, and mistakes another sentence of the paragraph for the one picked. */
const MIN_SHARED = 0.5

const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size)
}

const squash = (t: string): string => t.replace(/\s+/g, ' ').trim()

/** The sentences of a text, found the way the selection finds them (so "the sentence under the cursor" is one of them), in order. */
function sentencesOf(text: string): string[] {
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    if (/\s/.test(text[at])) { at++; continue }
    const s = sentenceAround(text, at, at)
    const t = squash(text.slice(s.start, s.end))
    if (t) out.push(t)
    at = Math.max(s.end, at + 1)
  }
  return out
}

/** Every unit of one kind in the text, in order, with the white space inside each squeezed to single spaces. */
function unitsOf(text: string, unit: SelectionUnit): string[] {
  if (unit === 'article') return [squash(text)]
  if (unit === 'paragraph') return text.split(/\n{2,}/).map(squash).filter(Boolean)
  if (unit === 'section') return text.split(/\n(?=#{1,6} )/).map(squash).filter(Boolean)
  return sentencesOf(text)
}

/**
 * The unit of an older version that is the picked one: the same words, or the one that shares most of its words with it. Units that are, word
 * for word, another unit of the text as it is now are not it (another sentence of the paragraph is not an earlier wording of this one), so when
 * only such units resemble it, the piece was not in that version.
 */
function counterpart(markdown: string, unit: SelectionUnit, now: string, others: Set<string>): string | undefined {
  const target = words(now)
  let best: { text: string; score: number } | undefined
  for (const u of unitsOf(markdown, unit)) {
    if (u === now) return u
    if (others.has(u)) continue
    const score = overlap(words(u), target)
    if (score >= MIN_SHARED && (!best || score > best.score)) best = { text: u, score }
  }
  return best?.text
}

/** `versions` in any order. */
export function revisionsOfText(markdown: string, range: SelectionRange, versions: readonly VersionText[]): TextRevisions | undefined {
  const found = unitOfSelection(markdown, range)
  if (!found) return undefined
  const now = squash(markdown.slice(found.range.start, found.range.end))
  const others = new Set(unitsOf(markdown, found.unit).filter((u) => u !== now))
  const revisions: TextRevision[] = [{ text: now }]
  let last: string | undefined = now
  for (const v of [...versions].sort((a, b) => b.index - a.index)) {
    const text = counterpart(v.markdown, found.unit, now, others)
    if (text === last) continue
    revisions.push({ index: v.index, kind: v.kind, label: v.label, at: v.at, text })
    last = text
  }
  return { unit: found.unit, now, revisions }
}
