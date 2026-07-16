import type { MemoryResult } from './adapter'

export function applyMode(existing: unknown, value: unknown, mode: string): unknown {
  if (mode !== 'append') return value
  if (existing === undefined) return [value]
  if (Array.isArray(existing)) return [...existing, value]
  return [existing, value]
}

// Query-side only — small and hardcoded (same "no benchmark corpus, tune from real cases" spirit
// as tool-yield-classifier.ts's marker list), so a query like "the dentist appointment" doesn't
// dilute its own score by requiring "the" to also match.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in'])

// A genuine substring match scores exactly 1.0; a value whose tokens all overlap the query's but
// not as a contiguous substring is capped below that, so existing FlowSpecs relying on
// min_score: 1.0 to mean "exact match only" keep working unchanged.
const EXACT_MATCH_SCORE = 1.0
const PARTIAL_MATCH_CAP = 0.95

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

// Walks the value and collects only leaf primitive content, skipping key names entirely — every
// stored ChatMessage/IndexedMessage already contains the literal key "role", so tokenizing
// JSON.stringify(value) directly would give any query containing that common word a free,
// meaningless partial-credit bump on every entry.
function collectLeafValues(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) collectLeafValues(item, out)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectLeafValues(v, out)
    return
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
  }
}

function scoreValue(value: unknown, query: string): number {
  try {
    const leaves: string[] = []
    collectLeafValues(value, leaves)
    const corpus = leaves.join(' ')

    if (corpus.toLowerCase().includes(query.toLowerCase())) return EXACT_MATCH_SCORE

    const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t))
    if (queryTokens.length === 0) return 0

    const valueTokens = new Set(tokenize(corpus))
    const matched = queryTokens.filter((t) => valueTokens.has(t)).length
    if (matched === 0) return 0

    return (matched / queryTokens.length) * PARTIAL_MATCH_CAP
  } catch {
    // non-serializable or pathological value — score stays 0
    return 0
  }
}

export function scoreEntries(entries: Iterable<[string, unknown]>, query: string, topK: number, minScore: number): MemoryResult[] {
  const results: MemoryResult[] = []
  for (const [key, value] of entries) {
    const score = scoreValue(value, query)
    if (score >= minScore) results.push({ key, value, score })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, topK)
}
