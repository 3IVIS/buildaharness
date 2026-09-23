import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { classifyScopeUrgency, FAIL_SAFE_CLASSIFICATION } from './scope-urgency-classifier.js'

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    this.receivedMessages.push(messages)
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

const ctx = { currentGoalDescription: 'plan a trip to Portugal' }

describe('classifyScopeUrgency', () => {
  it('SAME_TASK always collapses to IMMEDIATE regardless of the model\'s reported urgency', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"SAME_TASK","urgency":"DEFERRED"}')
    const result = await classifyScopeUrgency('actually make it business class', ctx, llm)
    expect(result).toEqual({ scopeRelation: 'SAME_TASK', urgency: 'IMMEDIATE' })
  })

  it('SAME_GOAL_NEW_TASK x IMMEDIATE passes through unchanged', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"SAME_GOAL_NEW_TASK","urgency":"IMMEDIATE"}')
    const result = await classifyScopeUrgency('also book the hotel now', ctx, llm)
    expect(result).toEqual({ scopeRelation: 'SAME_GOAL_NEW_TASK', urgency: 'IMMEDIATE' })
  })

  it('SAME_GOAL_NEW_TASK x DEFERRED passes through unchanged', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"SAME_GOAL_NEW_TASK","urgency":"DEFERRED"}')
    const result = await classifyScopeUrgency('remind me to pack sunscreen later', ctx, llm)
    expect(result).toEqual({ scopeRelation: 'SAME_GOAL_NEW_TASK', urgency: 'DEFERRED' })
  })

  it('NEW_GOAL x IMMEDIATE passes through unchanged', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"NEW_GOAL","urgency":"IMMEDIATE"}')
    const result = await classifyScopeUrgency('drop that, my server is down right now', ctx, llm)
    expect(result).toEqual({ scopeRelation: 'NEW_GOAL', urgency: 'IMMEDIATE' })
  })

  it('NEW_GOAL x DEFERRED passes through unchanged', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"NEW_GOAL","urgency":"DEFERRED"}')
    const result = await classifyScopeUrgency('separately, can you help me plan a birthday party sometime', ctx, llm)
    expect(result).toEqual({ scopeRelation: 'NEW_GOAL', urgency: 'DEFERRED' })
  })

  it('CANCEL_CURRENT passes through unchanged', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"CANCEL_CURRENT","urgency":"IMMEDIATE"}')
    const result = await classifyScopeUrgency('never mind, forget the trip', ctx, llm)
    expect(result).toEqual({ scopeRelation: 'CANCEL_CURRENT', urgency: 'IMMEDIATE' })
  })

  it('INV-41: an unrecognized scopeRelation value falls back to FAIL_SAFE_CLASSIFICATION', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"SOMETHING_ELSE","urgency":"IMMEDIATE"}')
    const result = await classifyScopeUrgency('hmm', ctx, llm)
    expect(result).toEqual(FAIL_SAFE_CLASSIFICATION)
  })

  it('INV-41: an unrecognized urgency value falls back to FAIL_SAFE_CLASSIFICATION', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"NEW_GOAL","urgency":"WHENEVER"}')
    const result = await classifyScopeUrgency('hmm', ctx, llm)
    expect(result).toEqual(FAIL_SAFE_CLASSIFICATION)
  })

  it('INV-41: malformed JSON falls back to FAIL_SAFE_CLASSIFICATION, never throws', async () => {
    const llm = new StructuredOnlyLLMClient('not json')
    const result = await classifyScopeUrgency('hmm', ctx, llm)
    expect(result).toEqual(FAIL_SAFE_CLASSIFICATION)
  })

  it('INV-41: a throwing LLM client falls back to FAIL_SAFE_CLASSIFICATION, never throws', async () => {
    const result = await classifyScopeUrgency('hmm', ctx, new ThrowingLLMClient())
    expect(result).toEqual(FAIL_SAFE_CLASSIFICATION)
  })

  it('passes model/onUsage through to callChatStructured', async () => {
    const llm = new StructuredOnlyLLMClient('{"scopeRelation":"SAME_TASK","urgency":"IMMEDIATE"}')
    let usage: unknown
    await classifyScopeUrgency('ok', ctx, llm, 'claude-sonnet-5', (u) => { usage = u })
    expect(llm.calls).toBe(1)
    void usage
  })
})
