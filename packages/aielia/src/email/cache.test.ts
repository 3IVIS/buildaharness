import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache, type EmailCache } from './cache.js'
import { CACHE_CONFORMANCE_CHECKS } from './cache-conformance.js'

describe('InMemoryEmailCache conformance', () => {
  for (const check of CACHE_CONFORMANCE_CHECKS) {
    it(check.name, async () => {
      await check.run(() => new InMemoryEmailCache())
    }, 30_000)
  }
})

/** Negative controls: broken caches must fail the suite. */
function broken(patch: (c: InMemoryEmailCache) => void) {
  return () => {
    const c = new InMemoryEmailCache()
    patch(c)
    return c as EmailCache
  }
}
const runAll = async (make: () => EmailCache): Promise<string[]> => {
  const failed: string[] = []
  for (const check of CACHE_CONFORMANCE_CHECKS) {
    try {
      await check.run(make)
    } catch {
      failed.push(check.name)
    }
  }
  return failed
}

describe('conformance suite negative controls', () => {
  it('a cache that ignores message deletes fails', async () => {
    const failed = await runAll(broken((c) => { c.deleteMessages = async () => {} }))
    expect(failed.some((n) => n.includes('deleting a message'))).toBe(true)
  })
  it('a cache that ignores thread deletes fails', async () => {
    const failed = await runAll(broken((c) => { c.deleteThreads = async () => {} }))
    expect(failed.some((n) => n.includes('deleting a thread'))).toBe(true)
  })
  it('a cache that ignores the offset fails', async () => {
    const failed = await runAll(broken((c) => {
      const q = c.queryMessages.bind(c)
      c.queryMessages = (query, w) => q(query, { ...w, offset: 0 })
    }))
    expect(failed.some((n) => n.includes('windows'))).toBe(true)
  })
  it('a cache that returns live references fails', async () => {
    const failed = await runAll(broken((c) => {
      const store = new Map<string, import('./model.js').Message>()
      c.upsertMessages = async (ms) => { for (const m of ms) store.set(m.id, m) }
      c.getMessage = async (id) => store.get(id)
    }))
    expect(failed.some((n) => n.includes('copies'))).toBe(true)
  })
  it('a cache that keeps stale tokens after clearAccount fails', async () => {
    const failed = await runAll(broken((c) => {
      const tokens = new Map<string, string>()
      c.setSyncToken = async (a, t) => { if (t === undefined) tokens.delete(a); else tokens.set(a, t) }
      c.getSyncToken = async (a) => tokens.get(a)
      c.clearAccount = async () => {}
    }))
    expect(failed.some((n) => n.includes('clearAccount'))).toBe(true)
  })
})
