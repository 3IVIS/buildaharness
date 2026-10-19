import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import { MemoryService, DURABLE_FACTS_KEY } from './memory-service.js'
import { InMemoryEventSink, MemoryEventSchema, MEMORY_EVENTS_KEY, factKey, foldDurable, formatMemoryEvents, scrubForgotten, type MemoryEvent } from './memory-events.js'
import type { UserFact } from './fact-extraction.js'
import type { StatedFact } from './turn-intent-classifier.js'

const llm = (contradictions: unknown[] = []) => ({
  async *callChat() { yield '' },
  async callChatSync() { return '' },
  async callChatStructured() { return { content: JSON.stringify({ contradictions, corroborations: [] }) } },
})
function makeService(contradictions: unknown[] = []) {
  const memory = new InMemoryAdapter()
  const service = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm(contradictions) as never, () => undefined)
  const sink = new InMemoryEventSink()
  service.addEventSink(sink)
  return { memory, service, sink }
}
const judged = (text: string, over: Partial<StatedFact> = {}): StatedFact => ({
  text, durable: true, confidence: 'high', category: 'preference', containsSecret: false, looksLikeInstruction: false, ...over,
})
const durableKeys = async (memory: InMemoryAdapter) => (((await memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(factKey)
const stored = async (memory: InMemoryAdapter) => ((await memory.get(MEMORY_EVENTS_KEY)) as MemoryEvent[] | undefined) ?? []

describe('memory events (E1)', () => {
  beforeEach(() => { delete process.env.AUDIT_MEMORY_EVENTS })
  afterEach(() => { delete process.env.AUDIT_MEMORY_EVENTS; delete process.env.AUDIT_MEMORY_AUDIT_LOG })

  it('promote: a stated durable fact leaves a promote event with reason, source and no fact text', async () => {
    const { service, memory, sink } = makeService()
    await service.recordFacts('s1', 'I use vim', [judged('the user prefers vim', { key: 'editor' })])
    const e = sink.events.find((x) => x.kind === 'promote')!
    expect(MemoryEventSchema.parse(e)).toBeTruthy()
    expect(e.reason).toBe('inferred_high_conf')
    expect(e.sources.length).toBeGreaterThan(0)
    expect(e.attributeKey).toBe('editor')
    expect(JSON.stringify(await stored(memory))).not.toContain('vim')
  })

  it('decline: a medium-confidence inference is queued and a low one stays session-only, each with its own reason', async () => {
    const { service, sink } = makeService()
    await service.recordFacts('s1', 'maybe', [judged('the user maybe likes tea', { confidence: 'medium' }), judged('the user might like jazz', { confidence: 'low' })])
    const reasons = sink.events.filter((e) => e.kind === 'decline').map((e) => e.reason).sort()
    expect(reasons).toEqual(['inferred_low_conf_session_only', 'inferred_pending_confirmation'])
  })

  it('decline: restating a stored value is recorded as a duplicate', async () => {
    const { service, sink } = makeService()
    await service.recordFacts('s1', 'a', [judged('the user prefers vim', { key: 'editor' })])
    await service.recordFacts('s2', 'a', [judged('the user prefers vim', { key: 'editor' })])
    expect(sink.events.some((e) => e.kind === 'decline' && e.reason === 'duplicate')).toBe(true)
  })

  it('supersede: a keyed correction records both ids and the prior fact as a source', async () => {
    const { service, sink } = makeService()
    await service.recordFacts('s1', 'a', [judged('the user lives in Paris', { key: 'home' })])
    await service.recordFacts('s2', 'actually Rome', [judged('the user lives in Rome', { key: 'home' })])
    const e = sink.events.find((x) => x.kind === 'supersede')!
    expect(e.afterFactId).toBeTruthy()
    expect(e.reason).toBe('superseded_by_newer')
    expect(e.sources.some((s) => s.type === 'prior_fact')).toBe(true)
  })

  it('contradict: a detected contradiction is an event even though nothing is retracted', async () => {
    const { service, sink } = makeService([{ beliefIds: ['new-0', 'existing-0'], description: 'conflict' }])
    await service.recordFacts('s1', 'a', [judged('the user is vegetarian')])
    await service.recordFacts('s2', 'b', [judged('the user eats steak daily')])
    const e = sink.events.find((x) => x.kind === 'contradict')!
    expect(e.reason).toBe('conflicts_with_fact')
    expect(e.sources.some((s) => s.type === 'prior_fact')).toBe(true)
  })

  it('forget: no recoverable text in the stored events, even with images on', async () => {
    process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    const { service, memory, sink } = makeService()
    await service.recordFacts('s1', 'a', [judged('the user owns a zeppelin named Gerald')])
    expect(JSON.stringify(await stored(memory))).toContain('zeppelin')
    await service.forgetFact(0, 's1')
    expect(sink.events.some((e) => e.kind === 'forget' && e.reason === 'explicit_forget')).toBe(true)
    expect(JSON.stringify(await stored(memory))).not.toMatch(/zeppelin|Gerald/)
  })

  it('replay: folding the stored events from empty reproduces the durable list', async () => {
    const { service, memory } = makeService()
    await service.recordFacts('s1', 'a', [judged('the user lives in Paris', { key: 'home' }), judged('the user likes tea')])
    await service.recordFacts('s2', 'b', [judged('the user lives in Rome', { key: 'home' }), judged('the user likes jazz')])
    expect((await service.forgetFact(0, 's2'))?.text).toContain('tea')
    const folded = foldDurable(await stored(memory))
    expect(folded.unsupported).toBe(0)
    expect(folded.ids).toEqual(await durableKeys(memory))
  })

  it('AUDIT_MEMORY_EVENTS=0 stores nothing', async () => {
    process.env.AUDIT_MEMORY_EVENTS = '0'
    const { service, memory } = makeService()
    await service.recordFacts('s1', 'a', [judged('the user likes tea')])
    expect(await stored(memory)).toEqual([])
  })

  it('formats reason and sources, and a hand-built scrub drops quotes', () => {
    const e: MemoryEvent = { seq: 1, at: 't', session: 's', turn: 's', kind: 'promote', factId: 'f_1', reason: 'user_stated', sources: [{ type: 'user_message', ref: 'm1', quote: 'secret words' }], decidedBy: 'rule' }
    expect(formatMemoryEvents([e])).toContain('user_stated by rule')
    expect(JSON.stringify(scrubForgotten([e], new Set(['f_1'])))).not.toContain('secret words')
  })

  it('structural: the durable key is written only in commitDurable, which reaches the event funnel', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'memory-service.ts'), 'utf8')
    expect(src.match(/memory\.set\(DURABLE_FACTS_KEY/g)?.length).toBe(1)
    const body = src.slice(src.indexOf('private async commitDurable'), src.indexOf('private async commitDurable') + 400)
    expect(body).toContain('this.appendAudit(drafts)')
    const funnel = src.slice(src.indexOf('private async appendAudit'), src.indexOf('private async appendAudit') + 400)
    expect(funnel).toContain('this.emitEvents(')
  })
})
