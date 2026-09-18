import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import type { Belief } from '@buildaharness/harness'
import { checkSemanticCriterionCoverage, NON_CHECKABLE_DEFAULT_CRITERION } from './semantic-criterion-coverage.js'

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

function belief(id: string, statement: string): Belief {
  return { id, statement, confidence: 0.9, derived_from: [], recorded_at: '2026-07-25T00:00:00.000Z' }
}

describe('checkSemanticCriterionCoverage', () => {
  it('returns false without calling the LLM when there are no beliefs at all', async () => {
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const result = await checkSemanticCriterionCoverage('the login tests pass', [], llm)
    expect(result).toBe(false)
    expect(llm.calls).toBe(0)
  })

  it('calls the LLM and reports coverage for a paraphrased criterion', async () => {
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const result = await checkSemanticCriterionCoverage(
      'the login tests pass',
      [belief('b1', 'every authentication-related test in the suite is green')],
      llm,
    )
    expect(llm.calls).toBe(1)
    expect(result).toBe(true)
    const [sentMessages] = llm.receivedMessages
    const userMessage = sentMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('the login tests pass')
    expect(userMessage).toContain('authentication-related test')
  })

  it('returns false when the model reports no coverage', async () => {
    const llm = new StructuredOnlyLLMClient('{"covered":false}')
    const result = await checkSemanticCriterionCoverage('the login tests pass', [belief('b1', 'the weather is sunny today')], llm)
    expect(result).toBe(false)
  })

  it('returns false on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await checkSemanticCriterionCoverage('the login tests pass', [belief('b1', 'x')], llm)
    expect(result).toBe(false)
  })

  it('returns false when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await checkSemanticCriterionCoverage('the login tests pass', [belief('b1', 'x')], llm)
    expect(result).toBe(false)
  })

  it('returns false without calling the LLM for the ad hoc single-task turn default criterion, even with beliefs present', async () => {
    // This meta-instruction criterion isn't a factual claim any belief could ever state or
    // paraphrase — without this skip, every ordinary chat turn with at least one recorded belief
    // would spend a real LLM call here, forever, for a criterion that can never be "covered".
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const result = await checkSemanticCriterionCoverage(
      NON_CHECKABLE_DEFAULT_CRITERION,
      [belief('b1', 'the user lives in Berlin')],
      llm,
    )
    expect(result).toBe(false)
    expect(llm.calls).toBe(0)
  })
})
