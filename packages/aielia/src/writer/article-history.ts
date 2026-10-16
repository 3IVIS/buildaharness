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

export const MAX_CHECKPOINTS = 20

/** Adds a snapshot, keeping every published one and at most MAX_CHECKPOINTS of the newest checkpoints. */
export function addSnapshot(snapshots: readonly Snapshot[], snapshot: Snapshot, maxCheckpoints: number = MAX_CHECKPOINTS): Snapshot[] {
  const all = [...snapshots, snapshot]
  const checkpointIdx = all.map((s, i) => (s.kind === 'checkpoint' ? i : -1)).filter((i) => i >= 0)
  const drop = new Set(checkpointIdx.slice(0, Math.max(0, checkpointIdx.length - maxCheckpoints)))
  return all.filter((_, i) => !drop.has(i))
}

/** True when a new text differs enough from the last one that the writer would want to be able to go back: at least 5 changed lines and 40% of the longer text. */
export function isLargeChange(before: string, after: string): boolean {
  const changed = diffLines(before, after).filter((l) => l.type !== 'same').length
  const longer = Math.max(before.split('\n').length, after.split('\n').length)
  return changed >= 5 && changed >= longer * 0.4
}
