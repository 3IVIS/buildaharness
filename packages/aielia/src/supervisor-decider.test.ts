import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import type { TrajectoryDigestData } from '@buildaharness/harness'
import { decideSupervisorDirective } from './supervisor-decider.js'

const DIGEST: TrajectoryDigestData = {
  goal: ['ship the widget'],
  steps_taken: 12,
  stall_reason: 'strategy_loop',
  stall_history: ['0', '0', '0'],
  strategies_tried: [{ strategy: 'DIRECT_EDIT', outcome: 'switched' }],
  failure_classes: [],
  reopened_tasks: [],
  open_contradictions: [],
  blocking_unknowns: ['which config file is authoritative'],
  budget_remaining: {},
}

class FixedLLMClient implements ILLMClient {
  calls = 0
  received: ChatMessage[][] = []
  constructor(private readonly content: string) {}
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    this.calls++
    this.received.push(messages)
    return { content: this.content }
  }
}

class ThrowingLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    throw new Error('backend unreachable')
  }
}

describe('decideSupervisorDirective', () => {
  it('passes the digest through and returns the parsed directive object', async () => {
    const llm = new FixedLLMClient('{"action":"REDIRECT_STRATEGY","rationale":"tried direct edits twice","strategy_hint":"TRACE_EXEC","plan_note":null,"investigation":null,"question":null}')
    const out = await decideSupervisorDirective(DIGEST, llm)
    expect(llm.calls).toBe(1)
    expect(JSON.parse(llm.received[0][1].content as string)).toEqual(DIGEST)
    expect(out).toMatchObject({ action: 'REDIRECT_STRATEGY', strategy_hint: 'TRACE_EXEC' })
  })

  it('returns an ASK_USER directive with its structured question intact', async () => {
    const llm = new FixedLLMClient('{"action":"ASK_USER","rationale":"two configs, cannot tell which","question":{"question":"which config is authoritative?","options":["a.yaml","b.yaml"]}}')
    const out = await decideSupervisorDirective(DIGEST, llm)
    expect(out?.action).toBe('ASK_USER')
    expect((out as { question?: { question: string } }).question?.question).toBe('which config is authoritative?')
  })

  it('fails safe to null (→ CONTINUE) on an LLM error', async () => {
    expect(await decideSupervisorDirective(DIGEST, new ThrowingLLMClient())).toBeNull()
  })

  it('fails safe to null on an unparseable body', async () => {
    expect(await decideSupervisorDirective(DIGEST, new FixedLLMClient('not json at all'))).toBeNull()
  })

  it('fails safe to null when the body parses to a non-object', async () => {
    expect(await decideSupervisorDirective(DIGEST, new FixedLLMClient('"just a string"'))).toBeNull()
  })
})
