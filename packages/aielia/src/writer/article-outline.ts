import { parseSections } from './article-sections.js'

/**
 * The outline of the text as it is now: the headings with their numbers. Drawn from the text itself (not from saved sections), so it follows the
 * writer while typing, and a heading renamed in the outline is a change of the text, which is where the heading lives.
 */

export interface OutlineEntry {
  /** "1", "1.2", … Empty for the title (a single top-level heading at the start). */
  number: string
  heading: string
  level: number
  /** Depth below the title, 0 for the top. */
  depth: number
  /** Where the heading line starts in the text. */
  start: number
  /** Where the section ends: just before the next heading of any level. */
  end: number
}

export function outlineOf(markdown: string): OutlineEntry[] {
  const headings = parseSections(markdown).filter((h) => h.level > 0)
  const levels = headings.map((h) => h.level)
  const hasTitle = headings.length > 1 && headings[0].level === 1 && levels.filter((l) => l === 1).length === 1
  const base = Math.min(...(hasTitle ? levels.slice(1) : levels), 6)
  const counters: number[] = []
  return headings.map((h, i) => {
    if (hasTitle && i === 0) return { number: '', heading: h.heading, level: h.level, depth: 0, start: h.start, end: h.end }
    const depth = Math.max(0, h.level - base)
    counters.length = Math.max(counters.length, depth)
    counters[depth] = (counters[depth] ?? 0) + 1
    counters.length = depth + 1
    return { number: Array.from(counters, (c) => c || 1).join('.'), heading: h.heading, level: h.level, depth: hasTitle ? depth + 1 : depth, start: h.start, end: h.end }
  })
}

/** The text with the heading line that starts at `start` given a new wording; its level (the hashes) is kept. Unchanged when the new wording is empty. */
export function renameHeadingInText(markdown: string, start: number, heading: string): string {
  const wording = heading.replace(/\s+/g, ' ').trim()
  const lineEnd = markdown.indexOf('\n', start)
  const end = lineEnd === -1 ? markdown.length : lineEnd
  const hashes = /^( {0,3}#{1,6}[ \t]+)/.exec(markdown.slice(start, end))
  if (!wording || !hashes) return markdown
  return markdown.slice(0, start) + hashes[1] + wording + markdown.slice(end)
}
