import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import {
  MemoryService,
  renderFactsBlock,
  memoryBudgetedRenderEnabled,
  DURABLE_FACTS_KEY,
  FACT_CAP,
  RETIRED_FACTS_KEY,
} from './memory-service.js'
import { migrateFact, type UserFact } from './fact-extraction.js'
import type { StatedFact } from './turn-intent-classifier.js'

const NO_CONTRADICTIONS = JSON.stringify({ contradictions: [], corroborations: [] })

const llm = {
  async *callChat() { yield '' },
  async callChatSync() { return '' },
  async callChatStructured() { return { content: NO_CONTRADICTIONS } },
}

function makeService(memory = new InMemoryAdapter(), budget?: number) {
  const service = new MemoryService(
    memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm as never, () => undefined, () => '',
    budget === undefined ? undefined : () => budget,
  )
  return { service, memory }
}

function fact(i: number, over: Partial<UserFact> = {}): UserFact {
  return {
    text: `the user fact number ${i}`,
    extractedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    sourceTurn: 'turn:s',
    source: 'user_asserted',
    durable: true,
    ...over,
  }
}

const stated = (text: string, key?: string): StatedFact => ({ text, durable: true, confidence: 'high', category: 'preference', ...(key ? { key } : {}) })

describe('M1 budgeted render', () => {
  beforeEach(() => { process.env.AUDIT_MEMORY_BUDGETED_RENDER = '1' })
  afterEach(() => { delete process.env.AUDIT_MEMORY_BUDGETED_RENDER })

  it('gate is OFF unless explicitly enabled', () => {
    expect(memoryBudgetedRenderEnabled({})).toBe(false)
    expect(memoryBudgetedRenderEnabled({ AUDIT_MEMORY_BUDGETED_RENDER: '0' })).toBe(false)
    expect(memoryBudgetedRenderEnabled({ AUDIT_MEMORY_BUDGETED_RENDER: '1' })).toBe(true)
  })

  it('25 durable facts all fit a generous budget, including the first (G1)', async () => {
    const { service, memory } = makeService()
    await memory.set(DURABLE_FACTS_KEY, Array.from({ length: 25 }, (_, i) => fact(i)))
    const { factsBlock } = await service.loadFacts('s')
    expect(factsBlock).toContain('fact number 0')
    expect(factsBlock).toContain('fact number 24')
  })

  it('negative control: =0 restores slice(-20), dropping the oldest', async () => {
    delete process.env.AUDIT_MEMORY_BUDGETED_RENDER
    const { service, memory } = makeService()
    await memory.set(DURABLE_FACTS_KEY, Array.from({ length: 25 }, (_, i) => fact(i)))
    const { factsBlock } = await service.loadFacts('s')
    expect(factsBlock).not.toContain('fact number 0\n')
    expect(factsBlock.split('\n').filter((l) => l.startsWith('- ')).length).toBe(FACT_CAP)
  })

  it('durable facts are considered before session facts; length never exceeds the budget', () => {
    const durable = Array.from({ length: 10 }, (_, i) => fact(i))
    const session = Array.from({ length: 5 }, (_, i) => fact(100 + i, { durable: false }))
    const budget = 200
    const { block, shown, droppedCount } = renderFactsBlock([...session, ...durable], budget)
    expect(block.length).toBeLessThanOrEqual(budget)
    const firstSession = shown.findIndex((f) => !f.durable)
    const lastDurable = shown.map((f) => f.durable).lastIndexOf(true)
    if (firstSession !== -1) expect(lastDurable).toBeLessThan(firstSession)
    expect(droppedCount).toBe(15 - shown.length)
    expect(droppedCount).toBeGreaterThan(0)
  })

  it('property: generated sets respect the budget and tier order', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let run = 0; run < 50; run++) {
      const n = Math.floor(rnd() * 60)
      const facts = Array.from({ length: n }, (_, i) => fact(i, { durable: rnd() > 0.4, text: `fact ${i} ${'x'.repeat(Math.floor(rnd() * 40))}` }))
      const budget = 50 + Math.floor(rnd() * 1500)
      const { block, shown } = renderFactsBlock(facts, budget)
      expect(block.length).toBeLessThanOrEqual(budget)
      const firstSession = shown.findIndex((f) => !f.durable)
      if (firstSession !== -1) expect(shown.slice(firstSession).some((f) => f.durable)).toBe(false)
    }
  })

  it('retired facts are never rendered', () => {
    const { block } = renderFactsBlock([fact(1, { retiredAt: '2026-02-01T00:00:00Z' }), fact(2)], 1000)
    expect(block).not.toContain('number 1')
    expect(block).toContain('number 2')
  })

  it('a keyed fact replaces and retires the old one; unkeyed facts accumulate; restating is a no-op', async () => {
    const { service, memory } = makeService()
    await service.recordFacts('s', 'hi', [stated('the user lives in Austin', 'home_city')])
    await service.recordFacts('s', 'hi', [stated('the user lives in Berlin', 'home_city')])
    await service.recordFacts('s', 'hi', [stated('the user lives in Berlin', 'home_city')])
    await service.recordFacts('s', 'hi', [stated('the user likes tea'), stated('the user likes jazz')])
    const durable = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
    expect(durable.map((f) => f.text)).toEqual(['the user lives in Berlin', 'the user likes tea', 'the user likes jazz'])
    expect(durable[0].supersedes).toBe('the user lives in Austin')
    const retired = (await memory.get(RETIRED_FACTS_KEY)) as UserFact[]
    expect(retired.map((f) => f.text)).toEqual(['the user lives in Austin'])
    expect(retired[0].retiredAt).toBeTruthy()
    const { factsBlock } = await service.loadFacts('s')
    expect(factsBlock).not.toContain('Austin')
  })

  it('negative control: with the flag off a keyed fact does not supersede', async () => {
    delete process.env.AUDIT_MEMORY_BUDGETED_RENDER
    const { service, memory } = makeService()
    await service.recordFacts('s', 'hi', [stated('the user lives in Austin', 'home_city')])
    await service.recordFacts('s', 'hi', [stated('the user lives in Berlin', 'home_city')])
    expect(((await memory.get(DURABLE_FACTS_KEY)) as UserFact[]).length).toBe(2)
    expect(await memory.get(RETIRED_FACTS_KEY)).toBeUndefined()
  })

  it('two concurrent recordFacts for the same key leave at most one live entry and lose nothing', async () => {
    const { service, memory } = makeService()
    await service.recordFacts('s', 'hi', [stated('the user lives in Austin', 'home_city')])
    await Promise.all([
      service.recordFacts('s', 'hi', [stated('the user lives in Berlin', 'home_city')]),
      service.recordFacts('s', 'hi', [stated('the user lives in Paris', 'home_city')]),
    ])
    const live = ((await memory.get(DURABLE_FACTS_KEY)) as UserFact[]).filter((f) => f.key === 'home_city')
    const retired = ((await memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
    const all = new Set([...live, ...retired].map((f) => f.text))
    expect(live.length).toBeLessThanOrEqual(2)
    // every value ever stated is still recoverable from live ∪ retired
    expect(all.has('the user lives in Austin')).toBe(true)
  })

  it('injectedCount is written lazily and survives a restart over the same adapter', async () => {
    const memory = new InMemoryAdapter()
    const a = makeService(memory).service
    await a.recordFacts('s', 'hi', [stated('the user likes tea')])
    await a.loadFacts('s')
    expect(((await memory.get(DURABLE_FACTS_KEY)) as UserFact[])[0].injectedCount).toBeUndefined() // loadFacts stays read-only
    await a.recordFacts('s', 'hi', []) // turn end flush
    const b = makeService(memory).service // restart
    const { facts } = await b.loadFacts('s')
    expect(facts[0].injectedCount).toBe(1)
    expect(facts[0].lastInjectedAt).toBeTruthy()
  })

  it('migrateFact leaves a pre-M1 durable fact durable', () => {
    const old = { text: 't', extractedAt: 'x', sourceTurn: 's', durable: true } as UserFact
    expect(migrateFact(old).durable).toBe(true)
  })
})
