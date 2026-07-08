import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import type { FailureModeEntry } from '@buildaharness/harness'
import { checkSemanticFailureMatch } from './failure-mode-matcher.js'

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

const library: FailureModeEntry[] = [
  { id: 'fm1', failure_class: 'timeout', symptoms: ['request timed out'], pattern_description: 'a request exceeded its deadline' },
]

describe('checkSemanticFailureMatch', () => {
  it('returns null without calling the LLM when there are no symptoms', async () => {
    const llm = new StructuredOnlyLLMClient('{"matched":false}')
    const result = await checkSemanticFailureMatch([], library, llm)
    expect(result).toBeNull()
    expect(llm.calls).toBe(0)
  })

  it('returns null without calling the LLM when the library has no entries', async () => {
    const llm = new StructuredOnlyLLMClient('{"matched":false}')
    const result = await checkSemanticFailureMatch(['the request took too long'], [], llm)
    expect(result).toBeNull()
    expect(llm.calls).toBe(0)
  })

  it('recognizes a paraphrased symptom the exact-match check would miss', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ matched: true, failure_class: 'timeout', matched_pattern: 'fm1', confidence: 0.8 }),
    )
    const result = await checkSemanticFailureMatch(['the request took too long and timed out eventually'], library, llm)
    expect(llm.calls).toBe(1)
    expect(result).toEqual({ failure_class: 'timeout', matched_pattern: 'fm1', confidence: 0.8 })
  })

  it('clamps an out-of-range confidence into [0, 1]', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ matched: true, failure_class: 'timeout', matched_pattern: 'fm1', confidence: 1.5 }),
    )
    const result = await checkSemanticFailureMatch(['timed out'], library, llm)
    expect(result?.confidence).toBe(1)
  })

  it('returns null when the model reports no match', async () => {
    const llm = new StructuredOnlyLLMClient('{"matched":false}')
    const result = await checkSemanticFailureMatch(['everything is fine'], library, llm)
    expect(result).toBeNull()
  })

  it('returns null on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await checkSemanticFailureMatch(['the request took too long'], library, llm)
    expect(result).toBeNull()
  })

  it('returns null when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await checkSemanticFailureMatch(['the request took too long'], library, llm)
    expect(result).toBeNull()
  })
})
