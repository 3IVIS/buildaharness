import Dexie, { type Table } from 'dexie'
import type { MemoryAdapter, MemoryResult } from './adapter'

interface MemoryRow {
  key: string
  value: unknown
}

class MemoryDB extends Dexie {
  entries!: Table<MemoryRow, string>

  constructor(namespace: string) {
    super(`buildaharness-memory-${namespace}`)
    this.version(1).stores({ entries: 'key' })
  }
}

// Module-level fallback store — shared across instances with the same namespace
// so two adapters in the same non-IDB environment (e.g. Node tests) can share state.
export const _fallbackStores: Map<string, Map<string, unknown>> = new Map()

function _isIDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

function getFallbackStore(namespace: string): Map<string, unknown> {
  if (!_fallbackStores.has(namespace)) {
    _fallbackStores.set(namespace, new Map())
  }
  return _fallbackStores.get(namespace)!
}

function applyMode(existing: unknown, value: unknown, mode: string): unknown {
  if (mode !== 'append') return value
  if (existing === undefined) return [value]
  if (Array.isArray(existing)) return [...existing, value]
  return [existing, value]
}

function scoreEntries(entries: Iterable<[string, unknown]>, query: string, topK: number, minScore: number): MemoryResult[] {
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

export interface IndexedDBAdapterOptions {
  namespace?: string
}

/**
 * Browser-persistent MemoryAdapter backed by IndexedDB via Dexie. Falls back to an
 * in-memory Map (shared by namespace) in environments without IndexedDB, e.g. Node tests.
 */
export class IndexedDBAdapter implements MemoryAdapter {
  private idbAvailable: boolean
  private db: MemoryDB | undefined
  private fallback: Map<string, unknown> | undefined

  constructor(opts: IndexedDBAdapterOptions = {}) {
    const { namespace = 'default' } = opts
    this.idbAvailable = _isIDBAvailable()
    if (this.idbAvailable) {
      this.db = new MemoryDB(namespace)
    } else {
      console.warn(
        `IndexedDBAdapter: IndexedDB not available (namespace="${namespace}"); falling back to in-memory store`,
      )
      this.fallback = getFallbackStore(namespace)
    }
  }

  async get(key: string): Promise<unknown> {
    if (this.db) {
      const row = await this.db.entries.get(key)
      return row?.value
    }
    return this.fallback!.get(key)
  }

  async set(key: string, value: unknown, mode = 'upsert'): Promise<void> {
    if (this.db) {
      const existing = await this.db.entries.get(key)
      await this.db.entries.put({ key, value: applyMode(existing?.value, value, mode) })
      return
    }
    this.fallback!.set(key, applyMode(this.fallback!.get(key), value, mode))
  }

  async search(query: string, topK = 5, minScore = 0.0): Promise<MemoryResult[]> {
    if (this.db) {
      const rows = await this.db.entries.toArray()
      return scoreEntries(rows.map(r => [r.key, r.value] as [string, unknown]), query, topK, minScore)
    }
    return scoreEntries(this.fallback!.entries(), query, topK, minScore)
  }

  async delete(key: string): Promise<void> {
    if (this.db) {
      await this.db.entries.delete(key)
      return
    }
    this.fallback!.delete(key)
  }
}
