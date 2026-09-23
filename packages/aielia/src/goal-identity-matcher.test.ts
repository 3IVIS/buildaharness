import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { matchGoalIdentity, type GoalCandidate } from './goal-identity-matcher.js'

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

const candidates: GoalCandidate[] = [
  { id: 'goal-1', description: 'Plan and book a trip to Portugal' },
  { id: 'goal-2', description: 'Migrate the billing service to the new database' },
]

describe('matchGoalIdentity', () => {
  it('returns no match without calling the LLM when there are no candidates', async () => {
    const llm = new StructuredOnlyLLMClient('{"matchedGoalId":null,"ambiguous":false}')
    const result = await matchGoalIdentity('find flights to Lisbon', [], llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: false })
    expect(llm.calls).toBe(0)
  })

  it('returns the matched candidate id when the model finds one', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ matchedGoalId: 'goal-1', ambiguous: false }))
    const result = await matchGoalIdentity('also look for a hotel near Lisbon', candidates, llm)
    expect(llm.calls).toBe(1)
    expect(result).toEqual({ matchedGoalId: 'goal-1', ambiguous: false })
    const [sentMessages] = llm.receivedMessages
    const userMessage = sentMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('Lisbon')
    expect(userMessage).toContain('goal-1')
    expect(userMessage).toContain('goal-2')
  })

  it('returns no match when the model finds none of the candidates relevant', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ matchedGoalId: null, ambiguous: false }))
    const result = await matchGoalIdentity('what is the capital of France', candidates, llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: false })
  })

  it('returns ambiguous with no match when the model cannot confidently pick one candidate', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ matchedGoalId: null, ambiguous: true }))
    const result = await matchGoalIdentity('check the status of the migration', candidates, llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: true })
  })

  it('forces matchedGoalId to null when the model sets ambiguous but also names an id', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ matchedGoalId: 'goal-2', ambiguous: true }))
    const result = await matchGoalIdentity('check the status', candidates, llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: true })
  })

  it('drops an unrecognized/dangling matchedGoalId instead of trusting it', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ matchedGoalId: 'goal-does-not-exist', ambiguous: false }))
    const result = await matchGoalIdentity('some message', candidates, llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: false })
  })

  it('returns no match on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await matchGoalIdentity('some message', candidates, llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: false })
  })

  it('returns no match when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await matchGoalIdentity('some message', candidates, llm)
    expect(result).toEqual({ matchedGoalId: null, ambiguous: false })
  })
})
