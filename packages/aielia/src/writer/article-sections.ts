import type { Section } from './article-model.js'

/**
 * Sections from the Markdown (headings define sections) and their re-anchoring after the text changes. Structure only:
 * a section keeps its id when its heading is unchanged, or when it is the one heading that changed in an otherwise
 * unchanged outline. Anything less certain gets a new id and the old record is reported as removed, never dropped silently.
 */

export interface ParsedHeading {
  heading: string
  level: number
  start: number
  end: number
}

/** ATX headings outside fenced code. Text before the first heading becomes a level-0 "lead" section when it is not blank. */
export function parseSections(markdown: string): ParsedHeading[] {
  const found: ParsedHeading[] = []
  let offset = 0
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
    } else if (fence === null) {
      const h = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
      if (h) found.push({ heading: h[2].trim(), level: h[1].length, start: offset, end: markdown.length })
    }
    offset += line.length + 1
  }
  for (let i = 0; i < found.length; i++) found[i].end = i + 1 < found.length ? found[i + 1].start : markdown.length
  const firstStart = found[0]?.start ?? markdown.length
  if (markdown.slice(0, firstStart).trim()) found.unshift({ heading: '', level: 0, start: 0, end: firstStart })
  return found
}

export interface ReconcileResult {
  sections: Section[]
  /** Ids kept, with the new heading when it was renamed. */
  kept: { id: string; renamedFrom?: string }[]
  created: string[]
  /** Previous sections that no longer match anything; shown to the writer, not deleted without that. */
  removed: Section[]
}

export function reconcileSections(previous: readonly Section[], markdown: string, newId: (taken: ReadonlySet<string>) => string): ReconcileResult {
  const parsed = parseSections(markdown)
  const taken = new Set(previous.map((s) => s.id))
  const assigned: (Section | undefined)[] = new Array(parsed.length).fill(undefined)
  const used = new Set<string>()

  // 1. same heading and level, in order
  parsed.forEach((p, i) => {
    const hit = previous.find((s) => !used.has(s.id) && s.heading === p.heading && s.level === p.level)
    if (hit) {
      assigned[i] = hit
      used.add(hit.id)
    }
  })
  // 2. exactly one unmatched new heading and one unmatched old section: the one heading that was renamed. Two or more is a guess, so none is paired.
  const freeNew = parsed.map((_, i) => i).filter((i) => !assigned[i])
  const freeOld = previous.filter((s) => !used.has(s.id)).sort((a, b) => a.order - b.order)
  const renamed = new Map<number, string>()
  if (freeNew.length === 1 && freeOld.length === 1) {
    freeNew.forEach((i, k) => {
      assigned[i] = freeOld[k]
      used.add(freeOld[k].id)
      renamed.set(i, freeOld[k].heading)
    })
  }

  const kept: ReconcileResult['kept'] = []
  const created: string[] = []
  const sections: Section[] = parsed.map((p, i) => {
    const prev = assigned[i]
    let id: string
    if (prev) {
      id = prev.id
      kept.push(renamed.has(i) ? { id, renamedFrom: renamed.get(i) } : { id })
    } else {
      id = newId(taken)
      taken.add(id)
      created.push(id)
    }
    return {
      id,
      heading: p.heading,
      level: p.level,
      order: i,
      purpose: prev?.purpose,
      span: { start: p.start, end: p.end },
      review: prev?.review ?? { state: 'clean' },
    }
  })
  // parents: the nearest earlier section with a lower level
  sections.forEach((s, i) => {
    for (let j = i - 1; j >= 0; j--) {
      if (sections[j].level < s.level && sections[j].level > 0) {
        s.parentId = sections[j].id
        break
      }
    }
  })
  return { sections, kept, created, removed: previous.filter((s) => !used.has(s.id)) }
}
