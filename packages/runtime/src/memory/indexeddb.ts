import type { MemoryAdapter, MemoryResult } from './adapter'

// Module-level fallback store — shared across instances with the same namespace
// so two adapters in the same non-IDB environment can share state.
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

export interface IndexedDBAdapterOptions {
  namespace?: string
  searchEndpoint?: string
}

export class IndexedDBAdapter implements MemoryAdapter {
  private idbAvailable: boolean
  private namespace: string
  private searchEndpoint: string | undefined
  private fallback: Map<string, unknown>

  constructor(opts: IndexedDBAdapterOptions = {}) {
    const { namespace = 'default', searchEndpoint } = opts
    this.namespace = namespace
    this.searchEndpoint = searchEndpoint
    this.idbAvailable = _isIDBAvailable()
    if (!this.idbAvailable) {
      console.warn(
        `IndexedDBAdapter: IndexedDB not available (namespace="${namespace}"); falling back to in-memory store`,
      )
      this.fallback = getFallbackStore(namespace)
    } else {
      // IDB path — fallback map not used but we still initialise it to satisfy TS
      this.fallback = getFallbackStore(namespace)
    }
  }

  async get(key: string): Promise<unknown> {
    if (this.idbAvailable) {
      throw new Error('IDB not implemented in server env')
    }
    return this.fallback.get(key)
  }

  async set(key: string, value: unknown, mode = 'upsert'): Promise<void> {
    if (this.idbAvailable) {
      throw new Error('IDB not implemented in server env')
    }
    if (mode === 'append') {
      const existing = this.fallback.get(key)
      if (existing === undefined) {
        this.fallback.set(key, [value])
      } else if (Array.isArray(existing)) {
        this.fallback.set(key, [...existing, value])
      } else {
        this.fallback.set(key, [existing, value])
      }
    } else {
      this.fallback.set(key, value)
    }
  }

  async search(query: string, topK = 5, minScore = 0.0): Promise<MemoryResult[]> {
    if (this.idbAvailable && this.searchEndpoint) {
      throw new Error('IDB search endpoint not implemented in server env')
    }
    // Linear scan on fallback map
    const results: MemoryResult[] = []
    for (const [key, value] of this.fallback.entries()) {
      let score = 0.0
      try {
        if (JSON.stringify(value).includes(query)) {
          score = 1.0
        }
      } catch {
        // non-serializable — score stays 0
      }
      if (score >= minScore) {
        results.push({ key, value, score })
      }
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  async delete(key: string): Promise<void> {
    if (this.idbAvailable) {
      throw new Error('IDB not implemented in server env')
    }
    this.fallback.delete(key)
  }
}
