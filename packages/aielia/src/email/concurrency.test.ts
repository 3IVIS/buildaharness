import { describe, expect, it } from 'vitest'
import { mapLimit } from './concurrency.js'
import { FakeEmailProvider } from './fake-provider.js'
import { InMemoryEmailCache } from './cache.js'
import { syncAccount } from './sync.js'
import { generateLabelledCorpus } from './labelled-corpus.js'
import { sampleTriageModel } from './offline-session.js'
import { InMemoryTriageStore, triageThreads, type TriageThread } from './triage.js'
import { runCatchUp } from './catch-up.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapLimit', () => {
  it('runs every item, never more than the limit at once, and 1 is sequential', async () => {
    for (const limit of [1, 3, 10]) {
      let active = 0, peak = 0
      const seen: number[] = []
      await mapLimit([1, 2, 3, 4, 5, 6, 7], limit, async (n) => { active++; peak = Math.max(peak, active); await wait(5); seen.push(n); active-- })
      expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
      expect(peak).toBeLessThanOrEqual(limit)
      if (limit > 1) expect(peak).toBeGreaterThan(1)
    }
  })
  it('an empty list and a nonsense limit are harmless', async () => {
    await mapLimit([], 3, async () => { throw new Error('never') })
    const seen: number[] = []
    await mapLimit([1, 2], 0, async (n) => { seen.push(n) })
    expect(seen).toEqual([1, 2])
  })
})

async function corpus() {
  const c = generateLabelledCorpus()
  const provider = new FakeEmailProvider(c.mailbox)
  const cache = new InMemoryEmailCache()
  await syncAccount(provider, cache)
  const threads = (await cache.listThreads(undefined, { offset: 0, limit: 1000 })).items
  const items: TriageThread[] = []
  for (const t of threads) items.push({ thread: t, messages: (await cache.queryMessages({ threadId: t.id }, { offset: 0, limit: 50 })).items })
  return { c, provider, cache, items }
}

describe('parallel batches give the same records as sequential ones', () => {
  it('triage with concurrency 3 equals concurrency 1, and overlaps its calls', async () => {
    const { c, provider, items } = await corpus()
    const base = sampleTriageModel(c.mailbox.categoryByThread)
    const run = async (concurrency: number) => {
      let active = 0, peak = 0
      const store = new InMemoryTriageStore()
      await triageThreads(items, { account: provider.account, model: async (s, u) => { active++; peak = Math.max(peak, active); await wait(8); const r = await base(s, u); active--; return r }, store, batchSize: 5, concurrency, now: () => '2026-11-02T00:00:00.000Z' })
      const out: Record<string, string> = {}
      for (const i of items) { const t = await store.get(i.thread.id); if (t) out[i.thread.id] = `${t.category}/${t.needsReply}` }
      return { out, peak }
    }
    const one = await run(1), three = await run(3)
    expect(one.peak).toBe(1)
    expect(three.peak).toBeGreaterThan(1)
    expect(three.peak).toBeLessThanOrEqual(3)
    expect(three.out).toEqual(one.out)
    expect(Object.keys(one.out).length).toBeGreaterThan(5)
  })
  it('catch-up with concurrency reports progress to the total and reviews everything once', async () => {
    const { c, provider, cache } = await corpus()
    const base = sampleTriageModel(c.mailbox.categoryByThread)
    const store = new InMemoryTriageStore()
    let last = { done: 0, total: 0 }
    const r = await runCatchUp({ account: provider.account, cache, store, model: base, batchSize: 4, concurrency: 3, onProgress: (p) => { last = p } })
    expect(r.status).toBe('complete')
    expect(last.done).toBe(last.total)
    expect(r.reviewed).toBe(last.total)
  })
  it('a stop request ends the run as interrupted even with several in flight', async () => {
    const { c, provider, cache } = await corpus()
    const base = sampleTriageModel(c.mailbox.categoryByThread)
    let calls = 0
    const r = await runCatchUp({ account: provider.account, cache, store: new InMemoryTriageStore(), model: async (s, u) => { calls++; return base(s, u) }, batchSize: 2, concurrency: 2, shouldStop: () => calls >= 2 })
    expect(r.status).toBe('interrupted')
  })
})
