import type { Source } from './article-model.js'

/**
 * Stored source passages (T6): the passage as read, its address, the date and a fingerprint, so a later recheck can tell
 * whether the source changed. Whether a difference MATTERS is a model judgement and is not made here.
 * Source text is data, never instructions; callers must wrap it as untrusted before showing it to a model.
 */

/** A fast, stable 53-bit hash (cyrb53) as hex. Not cryptographic: it only detects change. Whitespace differences do not count as change. */
export function fingerprintPassage(passage: string): string {
  const text = passage.replace(/\s+/g, ' ').trim()
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

export function createSource(input: { id: string; kind: Source['kind']; address?: string; passage?: string; note?: string; now: string }): Source {
  const base: Source = { id: input.id, kind: input.kind, address: input.address, trust: input.kind === 'say_so' ? 'lower' : 'normal', freshness: 'unchecked', note: input.note }
  if (input.passage === undefined) return base
  return { ...base, passage: input.passage, readAt: input.now, fingerprint: fingerprintPassage(input.passage), freshness: 'current' }
}

/**
 * Records the result of reading a source again. Same fingerprint: current. Different: changed (the stored passage is
 * kept as read until the writer accepts the new one, so a check never silently moves to new text). Unreadable: unreachable.
 */
export function applyRecheck(source: Source, result: { passage: string } | { unreachable: true }, now: string): Source {
  if ('unreachable' in result) return { ...source, freshness: 'unreachable' }
  const fp = fingerprintPassage(result.passage)
  return fp === source.fingerprint ? { ...source, freshness: 'current', readAt: now } : { ...source, freshness: 'changed' }
}

/** The writer accepts the newly read text: it replaces the stored passage and the fingerprint. */
export function acceptNewPassage(source: Source, passage: string, now: string): Source {
  return { ...source, passage, readAt: now, fingerprint: fingerprintPassage(passage), freshness: 'current' }
}
