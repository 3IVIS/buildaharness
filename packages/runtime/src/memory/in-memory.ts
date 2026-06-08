import type { MemoryAdapter, MemoryResult } from './adapter'

export interface InMemoryAdapterOptions {
  scope?: 'global' | 'thread' | 'resource'
  instanceId?: string
  namespace?: string
}

export class InMemoryAdapter implements MemoryAdapter {
  private store: Map<string, unknown> = new Map()
  private prefix: string

  constructor(opts: InMemoryAdapterOptions = {}) {
    const { scope = 'thread', instanceId = '', namespace = '' } = opts
    if (scope === 'global') {
      this.prefix = `global::${namespace}::`
    } else {
      // thread and resource both use instanceId to isolate
      this.prefix = `${scope}::${instanceId}::${namespace}::`
    }
  }

  private prefixed(key: string): string {
    return `${this.prefix}${key}`
  }

  async get(key: string): Promise<unknown> {
    return this.store.get(this.prefixed(key))
  }

  async set(key: string, value: unknown, mode = 'upsert'): Promise<void> {
    const prefixedKey = this.prefixed(key)
    if (mode === 'append') {
      const existing = this.store.get(prefixedKey)
      if (existing === undefined) {
        this.store.set(prefixedKey, [value])
      } else if (Array.isArray(existing)) {
        this.store.set(prefixedKey, [...existing, value])
      } else {
        this.store.set(prefixedKey, [existing, value])
      }
    } else {
      // 'upsert' and 'overwrite' both just set
      this.store.set(prefixedKey, value)
    }
  }

  async search(query: string, topK = 5, minScore = 0.0): Promise<MemoryResult[]> {
    const results: MemoryResult[] = []

    for (const [prefixedKey, value] of this.store.entries()) {
      if (!prefixedKey.startsWith(this.prefix)) continue
      const key = prefixedKey.slice(this.prefix.length)
      let score = 0.0
      try {
        if (JSON.stringify(value).includes(query)) {
          score = 1.0
        }
      } catch {
        // non-serializable value — score stays 0
      }
      if (score >= minScore) {
        results.push({ key, value, score })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(this.prefixed(key))
  }
}
