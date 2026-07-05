import type { MemoryResult } from './adapter'

export function applyMode(existing: unknown, value: unknown, mode: string): unknown {
  if (mode !== 'append') return value
  if (existing === undefined) return [value]
  if (Array.isArray(existing)) return [...existing, value]
  return [existing, value]
}

export function scoreEntries(entries: Iterable<[string, unknown]>, query: string, topK: number, minScore: number): MemoryResult[] {
  const results: MemoryResult[] = []
  for (const [key, value] of entries) {
    let score = 0.0
    try {
      if (JSON.stringify(value).includes(query)) score = 1.0
    } catch {
      // non-serializable value — score stays 0
    }
    if (score >= minScore) results.push({ key, value, score })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topK)
}
