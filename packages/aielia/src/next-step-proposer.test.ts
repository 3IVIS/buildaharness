import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { proposeNextSteps, classifySuggestionPromotion } from './next-step-proposer.js'
import type { GoalThread } from './goal-graph-store.js'

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  constructor(private readonly content: string) {}
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    return { content: this.content }
  }
}

class ThrowingLLMClient implements ILLMClient {
  calls = 0
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    this.calls++
    throw new Error('backend unreachable')
  }
}

function makeThread(overrides: Partial<GoalThread> = {}): GoalThread {
  const now = new Date().toISOString()
  return {
    id: 'thread-1',
    status: 'DONE',
    templateName: null,
    successCriteria: 'The login page works end to end',
    rationale: 'The user asked for a working login flow',
    tasks: [{ id: 't1', description: 'implement login form', depends_on: [], status: 'COMPLETE' }],
    mode: 'done',
    executingOnPlan: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('classifySuggestionPromotion', () => {
  it('maps high/medium/low to auto/pending_confirm/session_only', () => {
    expect(classifySuggestionPromotion('high')).toBe('auto')
    expect(classifySuggestionPromotion('medium')).toBe('pending_confirm')
    expect(classifySuggestionPromotion('low')).toBe('session_only')
  })
})

describe('proposeNextSteps', () => {
  it('does not call the LLM when the thread is not DONE', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ suggestions: [] }))
    const result = await proposeNextSteps(makeThread({ status: 'ACTIVE' }), llm, 'enabled')
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('does not call the LLM when goalGraphSuggestMode is disabled', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ suggestions: [] }))
    const result = await proposeNextSteps(makeThread(), llm, 'disabled')
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('generates SUGGESTED nodes for a DONE thread with the mode enabled, one per promotion branch', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({
        suggestions: [
          { description: 'add tests for the login page', confidence: 'high', rationale: 'tests were named as pending' },
          { description: 'add rate limiting', confidence: 'medium', rationale: 'common practice for login endpoints' },
          { description: 'consider a full auth rewrite', confidence: 'low', rationale: 'speculative' },
        ],
      }),
    )
    const result = await proposeNextSteps(makeThread(), llm, 'enabled')
    expect(llm.calls).toBe(1)
    expect(result).toHaveLength(3)
    expect(result.map((n) => n.promotion)).toEqual(['auto', 'pending_confirm', 'session_only'])
    for (const node of result) {
      expect(node.goalThreadId).toBe('thread-1')
      expect(node.id).toBeTruthy()
      expect(node.createdAt).toBeTruthy()
    }
  })

  it('returns an empty list on a malformed LLM response rather than throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json')
    const result = await proposeNextSteps(makeThread(), llm, 'enabled')
    expect(result).toEqual([])
  })

  it('returns an empty list when the LLM call throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await proposeNextSteps(makeThread(), llm, 'enabled')
    expect(result).toEqual([])
    expect(llm.calls).toBe(1)
  })

  it('drops malformed individual suggestion entries without discarding well-formed ones', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({
        suggestions: [
          { description: 'add tests', confidence: 'high', rationale: 'named as pending' },
          { description: '', confidence: 'high', rationale: 'missing description' },
          { confidence: 'not-a-level', rationale: 'bad confidence' },
        ],
      }),
    )
    const result = await proposeNextSteps(makeThread(), llm, 'enabled')
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('add tests')
  })
})
