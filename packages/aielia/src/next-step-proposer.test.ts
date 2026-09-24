import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { proposeNextSteps, proposeTurnNextSteps, classifySuggestionPromotion } from './next-step-proposer.js'
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

describe('proposeTurnNextSteps — options shown after a full turn', () => {
  const turn = { userMessage: 'Add a login page', reply: 'Done — I added login.tsx.' }
  const payload = JSON.stringify({
    suggestions: [
      { description: 'speculative refactor', confidence: 'low', rationale: 'r' },
      { description: 'add tests for the login page', confidence: 'high', rationale: 'r' },
      { description: 'wire it into the router', confidence: 'medium', rationale: 'r' },
      { description: 'a fourth option', confidence: 'medium', rationale: 'r' },
    ],
  })

  it('returns [] with no LLM call when the mode is not enabled', async () => {
    const llm = new StructuredOnlyLLMClient(payload)
    expect(await proposeTurnNextSteps(turn, llm, 'disabled')).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('returns [] with no LLM call when there is no request or no reply to follow up on', async () => {
    const llm = new StructuredOnlyLLMClient(payload)
    expect(await proposeTurnNextSteps({ userMessage: 'hi', reply: '  ' }, llm, 'enabled')).toEqual([])
    expect(await proposeTurnNextSteps({ userMessage: '', reply: 'x' }, llm, 'enabled')).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('orders most-confident first and caps at three', async () => {
    const out = await proposeTurnNextSteps(turn, new StructuredOnlyLLMClient(payload), 'enabled')
    expect(out.map((s) => s.description)).toEqual(['add tests for the login page', 'wire it into the router', 'a fourth option'])
  })

  it('sends the turn (request + reply) as the context, in one call', async () => {
    const seen: string[] = []
    const llm = new StructuredOnlyLLMClient(payload)
    const orig = llm.callChatStructured.bind(llm)
    llm.callChatStructured = async (m, t, o) => {
      seen.push(String(m[m.length - 1].content))
      return orig(m, t, o)
    }
    await proposeTurnNextSteps(turn, llm, 'enabled')
    expect(llm.calls).toBe(1)
    expect(seen[0]).toContain('Add a login page')
    expect(seen[0]).toContain('I added login.tsx')
  })

  it('falls back to [] on an LLM error or malformed output, never throwing', async () => {
    expect(await proposeTurnNextSteps(turn, new ThrowingLLMClient(), 'enabled')).toEqual([])
    expect(await proposeTurnNextSteps(turn, new StructuredOnlyLLMClient('not json'), 'enabled')).toEqual([])
  })
})

describe('the bigger picture reaches both proposers', () => {
  const bigPicture = {
    conversation: [{ role: 'user' as const, content: 'Read config/staging.yaml' }],
    stepsThisTurn: ['read_file config/staging.yaml'],
    goals: [{ goal: 'compare staging with prod', status: 'READY', focus: false, tasks: [] }],
  }

  function capture(llm: StructuredOnlyLLMClient): string[] {
    const seen: string[] = []
    const orig = llm.callChatStructured.bind(llm)
    llm.callChatStructured = async (m, t, o) => {
      seen.push(String(m[m.length - 1].content))
      return orig(m, t, o)
    }
    return seen
  }

  it('turn-level call sends earlier conversation, steps taken and the goal graph', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ suggestions: [] }))
    const seen = capture(llm)
    await proposeTurnNextSteps({ userMessage: 'How many workers?', reply: '6' }, llm, 'enabled', undefined, undefined, bigPicture)
    expect(seen[0]).toContain('earlierConversation')
    expect(seen[0]).toContain('Read config/staging.yaml')
    expect(seen[0]).toContain('stepsTaken')
    expect(seen[0]).toContain('goalGraph')
    expect(seen[0]).toContain('compare staging with prod')
  })

  it('thread-level call sends the same context', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ suggestions: [] }))
    const seen = capture(llm)
    await proposeNextSteps(makeThread(), llm, 'enabled', undefined, undefined, bigPicture)
    expect(seen[0]).toContain('earlierConversation')
    expect(seen[0]).toContain('goalGraph')
  })

  it('sends none of those keys when there is no extra context', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ suggestions: [] }))
    const seen = capture(llm)
    await proposeTurnNextSteps({ userMessage: 'q', reply: 'a' }, llm, 'enabled')
    expect(seen[0]).not.toContain('earlierConversation')
    expect(seen[0]).not.toContain('goalGraph')
    expect(seen[0]).not.toContain('stepsTaken')
  })
})
