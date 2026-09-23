import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { resolveTurnGoalThread } from './goal-thread-identity.js'
import { loadGoalGraphRecord, saveGoalGraphRecord, type GoalGraphRecord } from './goal-graph-store.js'
import { startThread } from './goal-thread-scheduler.js'

class MatcherLLM implements ILLMClient {
  calls = 0
  seen: unknown[] = []
  constructor(private readonly respond: (candidates: { id: string; description: string }[]) => string | Error) {}
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(messages: ChatMessage[], _t?: ToolDefinition[], _o?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    const payload = JSON.parse(String(messages[1].content)) as { message: string; candidates: { id: string; description: string }[] }
    this.seen.push(payload)
    const r = this.respond(payload.candidates)
    if (r instanceof Error) throw r
    return { content: r }
  }
}

const empty = (): GoalGraphRecord => ({ threads: [], activeThreadId: null, createdAt: 'x', updatedAt: 'x' })

async function seed(memory: InMemoryAdapter, sessionId = 's1'): Promise<{ loginId: string; partyId: string }> {
  let r = startThread(empty(), 'build a login page').record
  const loginId = r.threads[0].id
  r = startThread(r, 'plan a birthday party').record // login is now PAUSED, party ACTIVE
  const partyId = r.threads.find((t) => t.id !== loginId)!.id
  await saveGoalGraphRecord(memory, sessionId, r)
  return { loginId, partyId }
}

describe('resolveTurnGoalThread', () => {
  it('with no open threads, starts the first thread and makes no LLM call', async () => {
    const memory = new InMemoryAdapter()
    const llm = new MatcherLLM(() => new Error('should not be called'))

    const id = await resolveTurnGoalThread({ userMessage: 'build a login page', sessionId: 's1', memory, llmClient: llm })

    expect(llm.calls).toBe(0)
    const record = await loadGoalGraphRecord(memory, 's1')
    expect(record?.threads).toHaveLength(1)
    expect(record?.threads[0]).toMatchObject({ id, status: 'ACTIVE', successCriteria: 'build a login page' })
    expect(record?.activeThreadId).toBe(id)
  })

  it('a message that continues an earlier goal brings that thread back into focus and pauses the current one', async () => {
    const memory = new InMemoryAdapter()
    const { loginId, partyId } = await seed(memory)
    const llm = new MatcherLLM(() => JSON.stringify({ matchedGoalId: loginId, ambiguous: false }))

    const id = await resolveTurnGoalThread({ userMessage: 'now add tests for the login page', sessionId: 's1', memory, llmClient: llm })

    expect(id).toBe(loginId)
    const record = await loadGoalGraphRecord(memory, 's1')
    expect(record?.threads.find((t) => t.id === loginId)?.status).toBe('ACTIVE')
    expect(record?.threads.find((t) => t.id === partyId)?.status).toBe('PAUSED')
    expect(record?.activeThreadId).toBe(loginId)
  })

  it('matches against open threads only, describing each by its success criteria', async () => {
    const memory = new InMemoryAdapter()
    const { loginId } = await seed(memory)
    const record = (await loadGoalGraphRecord(memory, 's1'))!
    record.threads.push({ ...record.threads[0], id: 'finished', status: 'DONE', successCriteria: 'an old finished goal' })
    await saveGoalGraphRecord(memory, 's1', record)
    const llm = new MatcherLLM(() => JSON.stringify({ matchedGoalId: null, ambiguous: false }))

    await resolveTurnGoalThread({ userMessage: 'something', sessionId: 's1', memory, llmClient: llm })

    const candidates = (llm.seen[0] as { candidates: { id: string; description: string }[] }).candidates
    expect(candidates.map((c) => c.description).sort()).toEqual(['build a login page', 'plan a birthday party'])
    expect(candidates.some((c) => c.id === 'finished')).toBe(false)
    expect(loginId).toBeDefined()
  })

  it('no match: starts a new thread, pausing the current one as a concurrent sibling', async () => {
    const memory = new InMemoryAdapter()
    const { partyId } = await seed(memory)
    const llm = new MatcherLLM(() => JSON.stringify({ matchedGoalId: null, ambiguous: false }))

    const id = await resolveTurnGoalThread({ userMessage: 'summarize the quarterly report', sessionId: 's1', memory, llmClient: llm })

    const record = await loadGoalGraphRecord(memory, 's1')
    expect(record?.threads).toHaveLength(3)
    expect(record?.threads.find((t) => t.id === id)).toMatchObject({ status: 'ACTIVE', successCriteria: 'summarize the quarterly report' })
    expect(record?.threads.find((t) => t.id === partyId)?.status).toBe('PAUSED')
    expect(record?.threads.filter((t) => t.status === 'ACTIVE')).toHaveLength(1)
  })

  it('ambiguous: never guesses an attachment — starts a new thread', async () => {
    const memory = new InMemoryAdapter()
    await seed(memory)
    const llm = new MatcherLLM(() => JSON.stringify({ matchedGoalId: null, ambiguous: true }))
    const id = await resolveTurnGoalThread({ userMessage: 'do the next step', sessionId: 's1', memory, llmClient: llm })
    const record = await loadGoalGraphRecord(memory, 's1')
    expect(record?.threads).toHaveLength(3)
    expect(record?.threads.find((t) => t.id === id)?.successCriteria).toBe('do the next step')
  })

  it('a dangling id from the model is treated as no match, and an LLM error falls back to a new thread', async () => {
    const memory = new InMemoryAdapter()
    await seed(memory)
    const dangling = new MatcherLLM(() => JSON.stringify({ matchedGoalId: 'not-a-thread', ambiguous: false }))
    await resolveTurnGoalThread({ userMessage: 'x one', sessionId: 's1', memory, llmClient: dangling })
    expect((await loadGoalGraphRecord(memory, 's1'))?.threads).toHaveLength(3)

    const broken = new MatcherLLM(() => new Error('backend down'))
    await resolveTurnGoalThread({ userMessage: 'x two', sessionId: 's1', memory, llmClient: broken })
    expect((await loadGoalGraphRecord(memory, 's1'))?.threads).toHaveLength(4)
  })

  it('a message that matches a NEW_GOAL placeholder (drafting) adopts it instead of duplicating it', async () => {
    const memory = new InMemoryAdapter()
    const { partyId } = await seed(memory)
    const record = (await loadGoalGraphRecord(memory, 's1'))!
    const placeholder = { ...record.threads[0], id: 'placeholder', status: 'READY' as const, mode: 'drafting' as const, successCriteria: 'help me plan a trip to Lisbon' }
    record.threads.push(placeholder)
    await saveGoalGraphRecord(memory, 's1', record)
    const llm = new MatcherLLM(() => JSON.stringify({ matchedGoalId: 'placeholder', ambiguous: false }))

    const id = await resolveTurnGoalThread({ userMessage: 'help me plan a trip to Lisbon', sessionId: 's1', memory, llmClient: llm })

    expect(id).toBe('placeholder')
    const after = await loadGoalGraphRecord(memory, 's1')
    expect(after?.threads).toHaveLength(3) // no duplicate
    expect(after?.threads.find((t) => t.id === 'placeholder')).toMatchObject({ status: 'ACTIVE', mode: 'active' })
    expect(after?.threads.find((t) => t.id === partyId)?.status).toBe('PAUSED')
  })

  it('a match on a BLOCKED thread returns it (its evidence still lands there) without unblocking it', async () => {
    const memory = new InMemoryAdapter()
    const { loginId } = await seed(memory)
    const record = (await loadGoalGraphRecord(memory, 's1'))!
    record.threads.find((t) => t.id === loginId)!.status = 'BLOCKED'
    await saveGoalGraphRecord(memory, 's1', record)
    const llm = new MatcherLLM(() => JSON.stringify({ matchedGoalId: loginId, ambiguous: false }))

    const id = await resolveTurnGoalThread({ userMessage: 'continue the login page', sessionId: 's1', memory, llmClient: llm })

    expect(id).toBe(loginId)
    expect((await loadGoalGraphRecord(memory, 's1'))?.threads.find((t) => t.id === loginId)?.status).toBe('BLOCKED')
  })
})
