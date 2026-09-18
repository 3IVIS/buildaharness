import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import type { FailureModeEntry } from '@buildaharness/harness'
import { checkSemanticFailureMatch, semanticFailureMatchEnabled } from './failure-mode-matcher.js'

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

describe('semanticFailureMatchEnabled (AUDIT_SEMANTIC_FAILURE_MATCH gate — Phase A6)', () => {
  it('defaults ON when the flag is unset or empty', () => {
    expect(semanticFailureMatchEnabled({})).toBe(true)
    expect(semanticFailureMatchEnabled({ AUDIT_SEMANTIC_FAILURE_MATCH: '' })).toBe(true)
    expect(semanticFailureMatchEnabled({ AUDIT_SEMANTIC_FAILURE_MATCH: '  ' })).toBe(true)
  })

  it('stays ON for truthy values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', 'anything-else']) {
      expect(semanticFailureMatchEnabled({ AUDIT_SEMANTIC_FAILURE_MATCH: v }), v).toBe(true)
    }
  })

  it('turns OFF only for an explicit falsy value', () => {
    for (const v of ['0', 'false', 'off', 'no', 'disabled', 'DISABLED', ' Off ']) {
      expect(semanticFailureMatchEnabled({ AUDIT_SEMANTIC_FAILURE_MATCH: v }), v).toBe(false)
    }
  })

  it('when OFF, the failureMatchOff arm skips the checkSemanticFailureMatch LLM call entirely', async () => {
    // harness-bridge.ts gates the whole `semanticFailureMatcher` host hook on this helper, so an
    // OFF value means the LLM call site is never wired and only FailureModeLibrary.match()'s
    // exact-string-overlap check runs. Proven here at the unit boundary: the helper is the single
    // decision point.
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ matched: true, failure_class: 'timeout', matched_pattern: 'fm1', confidence: 0.8 }),
    )
    const symptoms = ['the request took too long and timed out eventually']

    if (semanticFailureMatchEnabled({ AUDIT_SEMANTIC_FAILURE_MATCH: '0' })) {
      await checkSemanticFailureMatch(symptoms, library, llm)
    }
    expect(llm.calls).toBe(0)

    if (semanticFailureMatchEnabled({})) {
      await checkSemanticFailureMatch(symptoms, library, llm)
    }
    expect(llm.calls).toBe(1)
  })
})
