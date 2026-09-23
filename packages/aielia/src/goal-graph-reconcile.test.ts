import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { LiveSteeringChannel } from './live-steering-channel.js'
import { createSteeringReconcileChannel } from './goal-graph-reconcile.js'
import { loadGoalGraphRecord, saveGoalGraphRecord, createEmptyGoalGraphRecord, createGoalThreadFromPlanRecord } from './goal-graph-store.js'
import { createPlanRecord } from './plan-store.js'
import type { Plan } from './plan-builder.js'

class ScriptedLLMClient implements ILLMClient {
  calls: ChatMessage[][] = []
  constructor(private readonly responses: string[]) {}
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls.push(messages)
    const content = this.responses[this.calls.length - 1] ?? this.responses.at(-1) ?? '{}'
    return { content }
  }
}

function makePlan(): Plan {
  return {
    templateName: 'trip_planning',
    successCriteria: 'Book a trip to Portugal.',
    tasks: [{ id: 't1', description: 'Find flights', depends_on: [], riskLevel: 'LOW' }],
  }
}

describe('createSteeringReconcileChannel', () => {
  it('channel.poll() returns null when nothing is queued, without calling the LLM', async () => {
    const memory = new InMemoryAdapter()
    const steeringChannel = new LiveSteeringChannel()
    const llm = new ScriptedLLMClient([])
    const { channel } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    const result = await channel.poll()

    expect(result).toBeNull()
    expect(llm.calls).toHaveLength(0)
  })

  it('SAME_TASK becomes a steering note the proposer takes once — never a harness constraint (the lexical negation rule would misfire on "not")', async () => {
    const memory = new InMemoryAdapter()
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('use the audited figure, not the draft one')
    const llm = new ScriptedLLMClient(['{"scopeRelation":"SAME_TASK","urgency":"IMMEDIATE"}'])
    const { channel, takeNotes, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    const result = await channel.poll()

    expect(result).toBeNull()
    expect(takeNotes()).toEqual(['use the audited figure, not the draft one'])
    expect(takeNotes()).toEqual([])
    expect(drainUnconsumed()).toEqual([]) // applied in place — nothing left to re-run
  })

  it('SAME_GOAL_NEW_TASK x IMMEDIATE is a note; x DEFERRED is deferred to a follow-up turn', async () => {
    const memory = new InMemoryAdapter()
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('also book a hotel')
    steeringChannel.enqueue('and later, rent a car')
    const llm = new ScriptedLLMClient([
      '{"scopeRelation":"SAME_GOAL_NEW_TASK","urgency":"IMMEDIATE"}',
      '{"scopeRelation":"SAME_GOAL_NEW_TASK","urgency":"DEFERRED"}',
    ])
    const { channel, takeNotes, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    expect(await channel.poll()).toBeNull()
    expect(await channel.poll()).toBeNull()

    expect(takeNotes()).toEqual(['also book a hotel'])
    expect(drainUnconsumed().map((e) => e.message)).toEqual(['and later, rent a car'])
  })

  it('a note the proposer never took (classified after its last LLM call) is drained as a follow-up, not lost', async () => {
    const memory = new InMemoryAdapter()
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('make it business class')
    const llm = new ScriptedLLMClient(['{"scopeRelation":"SAME_TASK","urgency":"IMMEDIATE"}'])
    const { channel, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    await channel.poll()

    expect(drainUnconsumed().map((e) => e.message)).toEqual(['make it business class'])
  })

  it('CANCEL_CURRENT abandons the active thread and emits a cancel_current CallerUpdate', async () => {
    const memory = new InMemoryAdapter()
    const thread = createGoalThreadFromPlanRecord(createPlanRecord(makePlan()), 'thread-1')
    await saveGoalGraphRecord(memory, 's1', { threads: [thread], activeThreadId: 'thread-1', createdAt: thread.createdAt, updatedAt: thread.updatedAt })
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('never mind, forget it')
    const llm = new ScriptedLLMClient(['{"scopeRelation":"CANCEL_CURRENT","urgency":"IMMEDIATE"}'])
    const { channel, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    const result = await channel.poll()

    expect(result).toEqual({ pending_update: { cancel_current: true }, constraints_changed: true })
    const goalGraph = await loadGoalGraphRecord(memory, 's1')
    expect(goalGraph?.threads.find((t) => t.id === 'thread-1')?.status).toBe('ABANDONED')
    // the message usually carries the replacement ask too — it runs as the next turn
    expect(drainUnconsumed().map((e) => e.message)).toEqual(['never mind, forget it'])
  })

  it('NEW_GOAL mints a new READY thread, pauses the active one, and returns null (no change to the running task graph this turn)', async () => {
    const memory = new InMemoryAdapter()
    const thread = createGoalThreadFromPlanRecord(createPlanRecord(makePlan()), 'thread-1')
    await saveGoalGraphRecord(memory, 's1', { threads: [thread], activeThreadId: 'thread-1', createdAt: thread.createdAt, updatedAt: thread.updatedAt })
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('separately, help me plan a birthday party')
    const llm = new ScriptedLLMClient(['{"scopeRelation":"NEW_GOAL","urgency":"DEFERRED"}'])
    const { channel, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    const result = await channel.poll()

    expect(result).toBeNull()
    // the ask itself is deferred to a follow-up turn — a drafting thread is never Scheduler-selectable (INV-40)
    expect(drainUnconsumed().map((e) => e.message)).toEqual(['separately, help me plan a birthday party'])
    const goalGraph = await loadGoalGraphRecord(memory, 's1')
    expect(goalGraph?.threads).toHaveLength(2)
    expect(goalGraph?.threads.find((t) => t.id === 'thread-1')?.status).toBe('PAUSED')
    expect(goalGraph?.threads.some((t) => t.status === 'READY' && t.successCriteria === 'separately, help me plan a birthday party')).toBe(true)
  })

  it('drains multiple queued messages one per poll(), FIFO; deferred asks come back in arrival order', async () => {
    const memory = new InMemoryAdapter()
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('first message')
    steeringChannel.enqueue('second message')
    const llm = new ScriptedLLMClient(['{"scopeRelation":"SAME_GOAL_NEW_TASK","urgency":"DEFERRED"}'])
    const { channel, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    expect(await channel.poll()).toBeNull()
    expect(llm.calls).toHaveLength(1) // one classifier call per poll, not per backlog
    expect(await channel.poll()).toBeNull()
    expect(await channel.poll()).toBeNull()

    expect(llm.calls).toHaveLength(2)
    expect(drainUnconsumed().map((e) => e.message)).toEqual(['first message', 'second message'])
  })

  it('drainUnconsumed() also returns whatever was queued-but-not-yet-polled, never silently dropping it', async () => {
    const memory = new InMemoryAdapter()
    const steeringChannel = new LiveSteeringChannel()
    steeringChannel.enqueue('first message')
    steeringChannel.enqueue('second message')
    const llm = new ScriptedLLMClient(['{"scopeRelation":"SAME_GOAL_NEW_TASK","urgency":"DEFERRED"}'])
    const { channel, drainUnconsumed } = createSteeringReconcileChannel({ steeringChannel, sessionId: 's1', memory, llmClient: llm })

    await channel.poll() // classifies "first message" (deferred); "second message" is still buffered/unclassified

    const remaining = drainUnconsumed()
    expect(remaining.map((e) => e.message).sort()).toEqual(['first message', 'second message'])
    expect(drainUnconsumed()).toEqual([])
  })
})
