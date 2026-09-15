import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore, type ChatMessage, type ChatOptions, type ILLMClient, type LLMStructuredResponse, type ToolDefinition } from '@buildaharness/runtime'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import {
  MemoryService,
  DURABLE_FACTS_KEY,
  PENDING_CONFIRMATION_KEY,
  REJECTED_FACTS_KEY,
  type PendingFact,
  type RejectedFact,
} from './memory-service.js'
import type { UserFact } from './fact-extraction.js'
import type { StatedFact } from './turn-intent-classifier.js'

/** Pops one scripted `callChatStructured` JSON response per call, in order — throws if the test forgot to script a call, so an unexpectedly extra/missing LLM call fails loudly instead of silently returning stale data. */
class QueuedStructuredLLMClient implements ILLMClient {
  calls = 0
  receivedPayloads: unknown[] = []
  constructor(public readonly responses: string[]) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    const userMessage = messages.find((m) => m.role === 'user')?.content ?? '{}'
    this.receivedPayloads.push(JSON.parse(userMessage))
    const next = this.responses.shift()
    if (next === undefined) throw new Error('QueuedStructuredLLMClient: no more scripted responses')
    return { content: next }
  }
}

const EMPTY_CHECK = JSON.stringify({ contradictions: [], corroborations: [] })

function newService(llm: ILLMClient): { service: MemoryService; memory: InMemoryAdapter } {
  const memory = new InMemoryAdapter({ scope: 'thread', namespace: `memory-service-test-${Math.random()}` })
  const reminderStore = new InMemoryReminderStore(new InMemoryAdapter({ scope: 'thread', namespace: 'reminders' }))
  const experienceStore = new InMemoryExperienceStore()
  return { service: new MemoryService(memory, reminderStore, experienceStore, llm, () => undefined), memory }
}

const statedFact = (overrides: Partial<StatedFact> = {}): StatedFact => ({
  text: 'the user is vegetarian',
  durable: true,
  confidence: 'medium',
  category: 'preference',
  ...overrides,
})

describe('MemoryService.recordFacts', () => {
  it('is a true no-op (touches no store) when neither pass finds anything', async () => {
    const llm = new QueuedStructuredLLMClient([])
    const { service, memory } = newService(llm)
    const result = await service.recordFacts('s1', 'what time is it', [])
    expect(result).toEqual({ contradictions: [], corroborations: [] })
    expect(await memory.get('facts:s1')).toBeUndefined()
    expect(llm.calls).toBe(0)
  })

  it('auto-promotes a high-confidence durable LLM fact straight to DURABLE_FACTS_KEY', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'yes exactly', [statedFact({ text: 'the user is allergic to peanuts', confidence: 'high', category: 'health' })])
    const durable = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
    expect(durable).toHaveLength(1)
    expect(durable[0].confidence).toBe('high')
    expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
  })

  it('queues a medium-confidence durable LLM fact to PENDING_CONFIRMATION_KEY instead of promoting it', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'I think I might be lactose intolerant', [statedFact({ text: 'the user might be lactose intolerant', confidence: 'medium', category: 'health' })])
    expect(await memory.get(DURABLE_FACTS_KEY)).toBeUndefined()
    const pending = (await memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[]
    expect(pending).toHaveLength(1)
    expect(pending[0].category).toBe('health')
  })

  it('never queues a low-confidence fact — session-scoped only', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'my coworker mentioned I seem tired lately', [statedFact({ text: 'the user may be tired lately', confidence: 'low', category: 'other' })])
    expect(await memory.get(DURABLE_FACTS_KEY)).toBeUndefined()
    expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
    const session = (await memory.get('facts:s1')) as UserFact[]
    expect(session).toHaveLength(1)
  })

  it('retracts an uncertain-pool fact contradicted by a new statement, moving it to REJECTED_FACTS_KEY', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK])
    const { service, memory } = newService(llm)
    // Turn 1: capture a medium-confidence guess.
    await service.recordFacts('s1', 'I think I might be vegetarian', [statedFact({ text: 'the user might be vegetarian', confidence: 'medium', category: 'preference' })])
    expect((await memory.get(PENDING_CONFIRMATION_KEY) as PendingFact[])).toHaveLength(1)

    // Turn 2: a retraction — script the checker to report a contradiction against the uncertain pool.
    llm.responses.push(
      JSON.stringify({ contradictions: [{ beliefIds: ['new-0', 'uncertain-0'], description: 'Vegetarian and steak-eater cannot both be true.' }], corroborations: [] }),
    )
    await service.recordFacts('s1', 'Actually I eat steak all the time', [statedFact({ text: 'the user eats steak', confidence: 'high', durable: false })])

    const session = (await memory.get('facts:s1')) as UserFact[]
    expect(session.some((f) => f.text === 'the user might be vegetarian')).toBe(false)
    const pending = (await memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[]
    expect(pending).toHaveLength(0)
    const rejected = (await memory.get(REJECTED_FACTS_KEY)) as RejectedFact[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0].rejectionSource).toBe('auto_retracted')
  })

  it('upgrades a corroborated uncertain fact low→medium (queues it) and medium→high (promotes it)', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'my doctor says I should avoid dairy', [statedFact({ text: 'the user should avoid dairy', confidence: 'low', category: 'health' })])

    llm.responses.push(JSON.stringify({ contradictions: [], corroborations: [{ existingId: 'uncertain-0', newId: 'new-0' }] }))
    await service.recordFacts('s1', "I can't have dairy", [statedFact({ text: "the user can't have dairy", confidence: 'medium', category: 'health' })])
    let session = (await memory.get('facts:s1')) as UserFact[]
    let target = session.find((f) => f.text === 'the user should avoid dairy')
    expect(target?.confidence).toBe('medium')
    expect((await memory.get(PENDING_CONFIRMATION_KEY) as PendingFact[]).some((f) => f.text === 'the user should avoid dairy')).toBe(true)

    llm.responses.push(JSON.stringify({ contradictions: [], corroborations: [{ existingId: 'uncertain-0', newId: 'new-0' }] }))
    await service.recordFacts('s1', "I'm definitely lactose intolerant", [statedFact({ text: 'lactose intolerant restated', confidence: 'high', category: 'health' })])
    session = (await memory.get('facts:s1')) as UserFact[]
    target = session.find((f) => f.text === 'the user should avoid dairy')
    expect(target?.confidence).toBe('high')
    expect((await memory.get(DURABLE_FACTS_KEY) as UserFact[]).some((f) => f.text === 'the user should avoid dairy')).toBe(true)
    expect((await memory.get(PENDING_CONFIRMATION_KEY) as PendingFact[]).some((f) => f.text === 'the user should avoid dairy')).toBe(false)
  })
})

describe('MemoryService confirm/reject', () => {
  it('confirmPendingFact promotes by 0-based index and removes it from the pending store', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK, EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'a', [statedFact({ text: 'fact A', confidence: 'medium' })])
    await service.recordFacts('s1', 'b', [statedFact({ text: 'fact B', confidence: 'medium' })])
    expect((await memory.get(PENDING_CONFIRMATION_KEY) as PendingFact[])).toHaveLength(2)

    const outcome = await service.confirmPendingFact(0)
    expect(outcome?.fact.text).toBe('fact A')
    expect(outcome?.conflictNotice).toBeUndefined()
    const pending = (await memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[]
    expect(pending.map((f) => f.text)).toEqual(['fact B'])
    expect((await memory.get(DURABLE_FACTS_KEY) as UserFact[]).map((f) => f.text)).toEqual(['fact A'])
  })

  it('confirmPendingFact still promotes on a Knowledge conflict, surfacing it as an advisory conflictNotice', async () => {
    const llm = new QueuedStructuredLLMClient([
      EMPTY_CHECK,
      JSON.stringify({ contradictions: [{ beliefIds: ['confirm-0', 'existing-0'], description: 'Boston and Seattle cannot both be true.' }], corroborations: [] }),
    ])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'a', [statedFact({ text: 'the user lives in Seattle', confidence: 'medium', category: 'location', durable: true })])
    const outcome = await service.confirmPendingFact(0)
    expect(outcome?.conflictNotice).toContain('Boston and Seattle')
    expect((await memory.get(DURABLE_FACTS_KEY) as UserFact[])).toHaveLength(1)
  })

  it('confirmPendingFact returns undefined for an out-of-range index', async () => {
    const { service } = newService(new QueuedStructuredLLMClient([]))
    expect(await service.confirmPendingFact(0)).toBeUndefined()
  })

  it('rejectPendingFact removes the entry and records it as user_explicit in REJECTED_FACTS_KEY', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'a', [statedFact({ text: 'fact A', confidence: 'medium' })])
    const rejected = await service.rejectPendingFact(0)
    expect(rejected?.text).toBe('fact A')
    expect((await memory.get(PENDING_CONFIRMATION_KEY) as PendingFact[])).toHaveLength(0)
    const rejectedStore = (await memory.get(REJECTED_FACTS_KEY)) as RejectedFact[]
    expect(rejectedStore).toEqual([{ text: 'fact A', rejectedAt: rejectedStore[0].rejectedAt, rejectionSource: 'user_explicit' }])
  })

  it('confirmPendingCategory/rejectPendingCategory bulk-act on one category, leaving the rest untouched', async () => {
    const llm = new QueuedStructuredLLMClient([EMPTY_CHECK, EMPTY_CHECK, EMPTY_CHECK])
    const { service, memory } = newService(llm)
    await service.recordFacts('s1', 'a', [statedFact({ text: 'health fact', confidence: 'medium', category: 'health' })])
    await service.recordFacts('s1', 'b', [statedFact({ text: 'location fact', confidence: 'medium', category: 'location' })])
    await service.recordFacts('s1', 'c', [statedFact({ text: 'health fact 2', confidence: 'medium', category: 'health' })])

    const confirmed = await service.confirmPendingCategory('health')
    expect(confirmed.map((o) => o.fact.text).sort()).toEqual(['health fact', 'health fact 2'])
    const pending = (await memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[]
    expect(pending.map((f) => f.text)).toEqual(['location fact'])
    expect((await memory.get(DURABLE_FACTS_KEY) as UserFact[]).map((f) => f.text).sort()).toEqual(['health fact', 'health fact 2'])
  })
})
