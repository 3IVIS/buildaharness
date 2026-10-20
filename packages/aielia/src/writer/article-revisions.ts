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

const MIN_SHARED = 0.4

const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size)
}

/** Every unit of one kind in the text, in order. */
function unitsOf(text: string, unit: SelectionUnit): string[] {
  if (unit === 'article') return [text.trim()]
  if (unit === 'paragraph') return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (unit === 'section') {
    const parts = text.split(/\n(?=#{1,6} )/).map((p) => p.trim()).filter(Boolean)
    return parts
  }
  return text.split(/\n+/).flatMap((line) => line.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

function counterpart(markdown: string, unit: SelectionUnit, now: string): string | undefined {
  const target = words(now)
  let best: { text: string; score: number } | undefined
  for (const u of unitsOf(markdown, unit)) {
    if (u === now) return u
    const score = overlap(words(u), target)
    if (score >= MIN_SHARED && (!best || score > best.score)) best = { text: u, score }
  }
  return best?.text
}

/** `versions` in any order. */
export function revisionsOfText(markdown: string, range: SelectionRange, versions: readonly VersionText[]): TextRevisions | undefined {
  const found = unitOfSelection(markdown, range)
  if (!found) return undefined
  const now = markdown.slice(found.range.start, found.range.end).trim()
  const revisions: TextRevision[] = [{ text: now }]
  let last: string | undefined = now
  for (const v of [...versions].sort((a, b) => b.index - a.index)) {
    const text = counterpart(v.markdown, found.unit, now)
    if (text === last) continue
    revisions.push({ index: v.index, kind: v.kind, label: v.label, at: v.at, text })
    last = text
  }
  return { unit: found.unit, now, revisions }
}
