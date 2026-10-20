import type { ArticleMeta, SourceStatus } from './article-model.js'
import { computeReadiness, effectiveSourceStatus, type Readiness, type Snapshot } from './article-rules.js'

/**
 * Versions and what changed between them (article-model plan, section 7). Pure functions: a line diff of the text, the claims
 * whose shown status changed, the sources added, removed or changed, and the readiness counts side by side.
 */

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

/** Line diff by longest common subsequence. Articles are small, so the quadratic table is fine; very long inputs fall back to "all replaced". */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))]
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ type: 'del', text: a[i++] })
    else out.push({ type: 'add', text: b[j++] })
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] })
  while (j < b.length) out.push({ type: 'add', text: b[j++] })
  return out
}

export interface VersionSide {
  markdown: string
  meta: ArticleMeta
}

export interface VersionComparison {
  text: DiffLine[]
  changedLines: number
  claims: { quote: string; from: SourceStatus | 'absent'; to: SourceStatus | 'absent' }[]
  sources: { id: string; address?: string; change: 'added' | 'removed' | 'changed' }[]
  readiness: { from: Readiness; to: Readiness }
}

export function compareVersions(from: VersionSide, to: VersionSide): VersionComparison {
  const text = diffLines(from.markdown, to.markdown)
  const status = (side: VersionSide): Map<string, SourceStatus> => new Map(side.meta.claims.filter((c) => c.kind === 'factual').map((c) => [c.quote, effectiveSourceStatus(c, side.meta.sources)]))
  const a = status(from)
  const b = status(to)
  const claims: VersionComparison['claims'] = []
  for (const [quote, s] of b) if (a.get(quote) !== s) claims.push({ quote, from: a.get(quote) ?? 'absent', to: s })
  for (const [quote, s] of a) if (!b.has(quote)) claims.push({ quote, from: s, to: 'absent' })
  const sa = new Map(from.meta.sources.map((s) => [s.id, s]))
  const sb = new Map(to.meta.sources.map((s) => [s.id, s]))
  const sources: VersionComparison['sources'] = []
  for (const [id, s] of sb) {
    const old = sa.get(id)
    if (!old) sources.push({ id, address: s.address, change: 'added' })
    else if (old.fingerprint !== s.fingerprint) sources.push({ id, address: s.address, change: 'changed' })
  }
  for (const [id, s] of sa) if (!sb.has(id)) sources.push({ id, address: s.address, change: 'removed' })
  return { text, changedLines: text.filter((l) => l.type !== 'same').length, claims, sources, readiness: { from: computeReadiness(from.meta), to: computeReadiness(to.meta) } }
}

export interface ChangeSummary {
  /** No earlier version to compare with. */
  first: boolean
  added: number
  removed: number
  /** Headings of the sections whose text changed, were added or were removed. */
  sections: string[]
  /** Claims whose shown status changed, appeared or disappeared. */
  claims: number
  /** Sources added, removed or changed. */
  sources: number
}

function sectionTexts(side: VersionSide): Map<string, string> {
  return new Map(side.meta.sections.map((sec) => [sec.heading, side.markdown.slice(sec.span.start, sec.span.end)]))
}

/** What changed from one version to the next, in a form short enough for one line of a list. `from` is undefined for the first version. */
export function summarizeChange(from: VersionSide | undefined, to: VersionSide): ChangeSummary {
  if (!from) return { first: true, added: to.markdown === '' ? 0 : to.markdown.split('\n').length, removed: 0, sections: [], claims: 0, sources: 0 }
  const cmp = compareVersions(from, to)
  const a = sectionTexts(from)
  const b = sectionTexts(to)
  const names: string[] = []
  for (const [heading, text] of b) if (a.get(heading) !== text) names.push(heading || 'Opening')
  for (const heading of a.keys()) if (!b.has(heading)) names.push(heading || 'Opening')
  return {
    first: false,
    added: cmp.text.filter((l) => l.type === 'add').length,
    removed: cmp.text.filter((l) => l.type === 'del').length,
    sections: [...new Set(names)],
    claims: cmp.claims.length,
    sources: cmp.sources.length,
  }
}

export const MAX_CHECKPOINTS = 20

/** The label of a version the page saved by itself, and how many of those are kept (the oldest go first). They do not count towards MAX_CHECKPOINTS. */
export const AUTOSAVE_LABEL = 'Autosaved'
export const MAX_AUTOSAVES = 30

const isAutosave = (s: Snapshot): boolean => s.kind === 'checkpoint' && s.label === AUTOSAVE_LABEL

/** Adds a snapshot, keeping every published one, at most MAX_CHECKPOINTS of the newest checkpoints the writer or an action made, and at most MAX_AUTOSAVES of the newest autosaved ones. */
export function addSnapshot(snapshots: readonly Snapshot[], snapshot: Snapshot, maxCheckpoints: number = MAX_CHECKPOINTS): Snapshot[] {
  const all = [...snapshots, snapshot]
  const dropOldest = (pick: (s: Snapshot) => boolean, keep: number): number[] => {
    const idx = all.map((s, i) => (pick(s) ? i : -1)).filter((i) => i >= 0)
    return idx.slice(0, Math.max(0, idx.length - keep))
  }
  const drop = new Set([...dropOldest((s) => s.kind === 'checkpoint' && !isAutosave(s), maxCheckpoints), ...dropOldest(isAutosave, MAX_AUTOSAVES)])
  return all.filter((_, i) => !drop.has(i))
}

/** True when a new text differs enough from the last one that the writer would want to be able to go back: at least 5 changed lines and 40% of the longer text. */
export function isLargeChange(before: string, after: string): boolean {
  const changed = diffLines(before, after).filter((l) => l.type !== 'same').length
  const longer = Math.max(before.split('\n').length, after.split('\n').length)
  return changed >= 5 && changed >= longer * 0.4
}

export interface InlinePart {
  type: 'same' | 'del' | 'add'
  text: string
}

/** One line of a change as shown to the writer: a line only in one version, or a line changed in place with its words marked. */
export type DisplayLine = { type: 'add' | 'del'; text: string } | { type: 'change'; parts: InlinePart[] }

const tokens = (t: string): string[] => t.split(/(\s+)/).filter((x) => x !== '')

/** The words of a line changed into the words of another, as one run of parts; undefined when the two lines have too little in common to read as an edit of each other. */
export function inlineDiff(before: string, after: string): InlinePart[] | undefined {
  const a = tokens(before)
  const b = tokens(after)
  const m = a.length
  const n = b.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const parts: InlinePart[] = []
  const push = (type: InlinePart['type'], text: string): void => {
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.text += text
    else parts.push({ type, text })
  }
  let kept = 0
  for (let i = 0, j = 0; i < m || j < n; ) {
    if (i < m && j < n && a[i] === b[j]) { push('same', a[i]); if (a[i].trim()) kept++; i++; j++ } else if (i < m && (j >= n || lcs[i + 1][j] >= lcs[i][j + 1])) push('del', a[i++])
    else push('add', b[j++])
  }
  const words = Math.max(a.filter((t) => t.trim()).length, b.filter((t) => t.trim()).length)
  return words > 0 && kept / words >= 0.3 ? parts : undefined
}

/** The changed lines of a comparison, without the unchanged ones; a removed line followed by an added line that is an edit of it becomes one line with the changed words marked. */
export function diffForDisplay(lines: readonly DiffLine[]): DisplayLine[] {
  const out: DisplayLine[] = []
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type === 'same') { i++; continue }
    const dels: string[] = []
    const adds: string[] = []
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++].text)
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++].text)
    const edits = Array.from({ length: Math.min(dels.length, adds.length) }, (_, k) => inlineDiff(dels[k], adds[k]))
    for (let k = 0; k < dels.length; k++) {
      const e = edits[k]
      if (e) out.push({ type: 'change', parts: e })
      else out.push({ type: 'del', text: dels[k] })
    }
    for (let k = 0; k < adds.length; k++) if (!edits[k]) out.push({ type: 'add', text: adds[k] })
  }
  return out
}
