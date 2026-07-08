import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { checkSemanticReviewConflict } from './review-checker.js'

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

describe('checkSemanticReviewConflict', () => {
  it('returns no conflict without calling the LLM when the change reads like a coding action', async () => {
    const llm = new StructuredOnlyLLMClient('{"conflict":true,"reason":"should never be read"}')
    const result = await checkSemanticReviewConflict(
      'delete the config.yaml file',
      [{ id: 'b1', statement: 'config.yaml is required for the build' }],
      [],
      llm,
    )
    expect(result).toEqual({ conflict: false })
    expect(llm.calls).toBe(0)
  })

  it('calls the LLM and surfaces a real conflict for a natural-language-shaped change', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ conflict: true, reason: 'Dropping the login feature contradicts the belief that login is required.' }),
    )
    const result = await checkSemanticReviewConflict(
      "we're dropping the login feature",
      [{ id: 'b1', statement: 'login is a required feature for this release' }],
      [],
      llm,
    )
    expect(llm.calls).toBe(1)
    expect(result).toEqual({ conflict: true, reason: 'Dropping the login feature contradicts the belief that login is required.' })
    const [sentMessages] = llm.receivedMessages
    const userMessage = sentMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('dropping the login feature')
    expect(userMessage).toContain('login is a required feature')
  })

  it('returns no conflict when the model reports none', async () => {
    const llm = new StructuredOnlyLLMClient('{"conflict":false}')
    const result = await checkSemanticReviewConflict('rename the welcome message', [{ id: 'b1', statement: 'the user prefers formal language' }], [], llm)
    expect(result).toEqual({ conflict: false })
  })

  it('returns no conflict on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await checkSemanticReviewConflict('rename the welcome message', [{ id: 'b1', statement: 'x' }], [], llm)
    expect(result).toEqual({ conflict: false })
  })

  it('returns no conflict when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await checkSemanticReviewConflict('rename the welcome message', [{ id: 'b1', statement: 'x' }], [], llm)
    expect(result).toEqual({ conflict: false })
  })
})
