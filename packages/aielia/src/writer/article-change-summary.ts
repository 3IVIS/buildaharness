import { parseSections } from './article-sections.js'

/**
 * What a change did to an article, read from the text before and after: the outline (sections added, removed, renamed, moved) and the
 * sections whose wording changed. A comparison of the two texts, so the chat can say exactly what happened without asking a model.
 */
export interface SectionChange {
  outline: { added: string[]; removed: string[]; renamed: { from: string; to: string }[]; moved: string[] }
  /** Sections that kept their heading and whose text changed. */
  reworded: string[]
}

interface Part { heading: string; body: string }

const LEAD = 'the opening text'

function parts(markdown: string): Part[] {
  return parseSections(markdown).map((s) => ({ heading: s.level === 0 ? LEAD : s.heading, body: markdown.slice(s.start, s.end).replace(/^.*\n?/, (l) => (s.level === 0 ? l : '')).replace(/\s+/g, ' ').trim() }))
}

/** The longest run of `a` that appears in the same order in `b` (headings only, by name). */
function inOrder(a: string[], b: string[]): Set<string> {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const keep = new Set<string>()
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++ } else if (t[i + 1][j] >= t[i][j + 1]) i++
    else j++
  }
  return keep
}

export function summarizeSectionChange(before: string, after: string): SectionChange {
  const b = parts(before)
  const a = parts(after)
  const countIn = (list: Part[]): Map<string, number> => { const m = new Map<string, number>(); for (const p of list) m.set(p.heading, (m.get(p.heading) ?? 0) + 1); return m }
  const bc = countIn(b)
  const ac = countIn(a)
  // A heading present once on each side is "the same section"; anything else is added or removed.
  const shared = new Set([...bc.keys()].filter((h) => bc.get(h) === 1 && ac.get(h) === 1))
  const gone = b.map((p, i) => ({ p, i })).filter(({ p }) => !shared.has(p.heading))
  const fresh = a.map((p, i) => ({ p, i })).filter(({ p }) => !shared.has(p.heading))
  // The same number of unmatched headings, each at the position its partner had among all headings: a rename.
  const renamed: { from: string; to: string }[] = []
  let removed = gone.map(({ p }) => p.heading)
  let added = fresh.map(({ p }) => p.heading)
  if (gone.length > 0 && gone.length === fresh.length && gone.every(({ i }, k) => i === fresh[k].i)) {
    for (let k = 0; k < gone.length; k++) renamed.push({ from: gone[k].p.heading, to: fresh[k].p.heading })
    removed = []
    added = []
  }
  const order = inOrder(b.map((p) => p.heading).filter((h) => shared.has(h)), a.map((p) => p.heading).filter((h) => shared.has(h)))
  const moved = [...shared].filter((h) => !order.has(h))
  const bodyOf = (list: Part[], h: string): string | undefined => list.find((p) => p.heading === h)?.body
  const reworded = [...shared].filter((h) => bodyOf(b, h) !== bodyOf(a, h))
  // Document order, as the writer reads it.
  const pos = (h: string): number => a.findIndex((p) => p.heading === h)
  return { outline: { added, removed, renamed, moved: moved.sort((x, y) => pos(x) - pos(y)) }, reworded: reworded.sort((x, y) => pos(x) - pos(y)) }
}

const SHOWN = 4

/** Marks a section name inside chat text, so the chat can show names in a colour instead of between quotation marks. Private-use characters: they never occur in real text. */
export const NAME_OPEN = '\uE000'
export const NAME_CLOSE = '\uE001'
const name = (h: string): string => `${NAME_OPEN}${h.length > 40 ? `${h.slice(0, 40)}…` : h}${NAME_CLOSE}`
const list = (names: string[]): string => `${names.slice(0, SHOWN).map(name).join(', ')}${names.length > SHOWN ? ` and ${names.length - SHOWN} more` : ''}`

/** The summary as lines for the chat: one for the outline (when it changed) and one for the wording. Empty when nothing changed. */
export function describeSectionChange(c: SectionChange): string {
  const o = c.outline
  const outline = [
    o.added.length > 0 ? `added ${list(o.added)}` : '',
    o.removed.length > 0 ? `removed ${list(o.removed)}` : '',
    o.renamed.length > 0 ? `renamed ${o.renamed.slice(0, SHOWN).map((r) => `${name(r.from)} → ${name(r.to)}`).join(', ')}${o.renamed.length > SHOWN ? ` and ${o.renamed.length - SHOWN} more` : ''}` : '',
    o.moved.length > 0 ? `moved ${list(o.moved)}` : '',
  ].filter(Boolean)
  const lines: string[] = []
  if (outline.length > 0) lines.push(`• Outline: ${outline.join('; ')}.`)
  if (c.reworded.length > 0) lines.push(`• Reworded: ${list(c.reworded)}.`)
  return lines.join('\n')
}
