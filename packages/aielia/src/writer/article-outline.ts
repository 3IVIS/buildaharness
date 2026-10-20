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

/** The outline as plain text the writer edits: one heading per line, written the way it is in the article (`## Name`). */
export function outlineToText(markdown: string): string {
  return outlineOf(markdown).map((e) => `${'#'.repeat(e.level)} ${e.heading}`).join('\n')
}

interface WantedHeading {
  level: number
  heading: string
}

/** Lines of the outline text as headings. A line without hashes is a new heading at the level of the line above it. A line of hashes only is not finished yet. */
function wantedHeadings(outlineText: string): WantedHeading[] | null {
  const wanted: WantedHeading[] = []
  let level = 2
  for (const raw of outlineText.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(#{1,6})[ \t]*(.*)$/.exec(line)
    if (m && !m[2].trim()) return null
    if (m) level = m[1].length
    const heading = (m ? m[2] : line).replace(/\s+/g, ' ').trim()
    wanted.push({ level, heading })
  }
  return wanted
}

const keyOf = (h: { level: number; heading: string }): string => `${h.level}|${h.heading}`

/**
 * The article after the writer edited its outline as text. A heading kept as it was keeps its section; a heading reworded or moved to another
 * level keeps its section too (matched in order, within the gap between unchanged headings); a heading moved to another place takes its section
 * with it; a new line is a new, empty section; a deleted line removes the heading only, its text stays with the section above. Returns the
 * article unchanged while a line is only hashes.
 */
export function applyOutlineText(markdown: string, outlineText: string): string {
  const wanted = wantedHeadings(outlineText)
  if (wanted === null) return markdown
  const old = parseSections(markdown).filter((h) => h.level > 0)
  const oldKeys = old.map(keyOf)
  const newKeys = wanted.map(keyOf)
  if (oldKeys.length === newKeys.length && oldKeys.every((k, i) => k === newKeys[i])) return markdown

  // 1. headings that stayed, in order (longest common run)
  const m = old.length
  const n = wanted.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = oldKeys[i] === newKeys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const oldOf: (number | undefined)[] = new Array(n).fill(undefined)
  const usedOld = new Set<number>()
  const anchors: [number, number][] = []
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (oldKeys[i] === newKeys[j]) { oldOf[j] = i; usedOld.add(i); anchors.push([i, j]); i++; j++ } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  // 2. a heading moved elsewhere takes its section along
  for (let j = 0; j < n; j++) {
    if (oldOf[j] !== undefined) continue
    const i = old.findIndex((_, k) => !usedOld.has(k) && oldKeys[k] === newKeys[j])
    if (i !== -1) { oldOf[j] = i; usedOld.add(i) }
  }
  // 3. between unchanged headings, the rest pair up in order: those are rewordings
  const bounds: [number, number][] = [[-1, -1], ...anchors, [m, n]]
  for (let a = 0; a + 1 < bounds.length; a++) {
    const oldGap: number[] = []
    for (let i = bounds[a][0] + 1; i < bounds[a + 1][0]; i++) if (!usedOld.has(i)) oldGap.push(i)
    const newGap: number[] = []
    for (let j = bounds[a][1] + 1; j < bounds[a + 1][1]; j++) if (oldOf[j] === undefined) newGap.push(j)
    for (let p = 0; p < Math.min(oldGap.length, newGap.length); p++) { oldOf[newGap[p]] = oldGap[p]; usedOld.add(oldGap[p]) }
  }

  const lineEnd = (h: ParsedHeadingLike): number => { const e = markdown.indexOf('\n', h.start); return e === -1 || e > h.end ? h.end : e }
  let lead = markdown.slice(0, old[0]?.start ?? markdown.length)
  const pieces: string[] = []
  const orphan = (i: number): string => markdown.slice(Math.min(lineEnd(old[i]) + 1, old[i].end), old[i].end)
  const give = (text: string): void => { if (!text) return; if (pieces.length > 0) pieces[pieces.length - 1] += text; else lead += text }
  // the text of a deleted heading goes to the section above it as that stood in the article, so walk the old order for those
  const removedAfter = new Map<number, number[]>() // new index -> old headings removed right after it
  const removedFirst: number[] = []
  for (let i = 0; i < m; i++) {
    if (usedOld.has(i)) continue
    // the closest earlier old heading that is kept
    let k = i - 1
    while (k >= 0 && !usedOld.has(k)) k--
    if (k < 0) removedFirst.push(i)
    else { const j = oldOf.indexOf(k); removedAfter.set(j, [...(removedAfter.get(j) ?? []), i]) }
  }
  for (const i of removedFirst) give(orphan(i))
  for (let j = 0; j < n; j++) {
    const i = oldOf[j]
    const line = `${'#'.repeat(wanted[j].level)} ${wanted[j].heading}`
    if (i === undefined) pieces.push(`${line}\n\n`)
    else {
      const unchanged = oldKeys[i] === newKeys[j]
      const body = markdown.slice(lineEnd(old[i]), old[i].end)
      const headLine = unchanged ? markdown.slice(old[i].start, lineEnd(old[i])) : line
      pieces.push(`${headLine}${body}`)
    }
    for (const r of removedAfter.get(j) ?? []) give(orphan(r))
  }
  const joined = pieces.map((p, k) => (k < pieces.length - 1 && !p.endsWith('\n') ? `${p}\n` : p)).join('')
  return lead + joined
}

type ParsedHeadingLike = { start: number; end: number }
