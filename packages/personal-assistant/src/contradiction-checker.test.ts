import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { looksLikeCodingFact, checkForContradictions } from './contradiction-checker.js'

describe('looksLikeCodingFact', () => {
  it('flags structured/technical claims', () => {
    expect(looksLikeCodingFact('the build is passing')).toBe(true)
    expect(looksLikeCodingFact('the service is unavailable')).toBe(true)
    expect(looksLikeCodingFact('config.yaml exists in the repo')).toBe(true)
  })

  it('does not flag natural-language personal facts', () => {
    expect(looksLikeCodingFact('the user lives in Boston')).toBe(false)
    expect(looksLikeCodingFact('my name is Alex')).toBe(false)
    expect(looksLikeCodingFact('I prefer tea over coffee')).toBe(false)
  })

  it('does not flag "passed away" as a build/test-status coding fact', () => {
    // convT: "passed" alone matches the build/test-status sense this list exists for, but also
    // coincidentally matches the unrelated "passed away" (died) idiom — a pet-death correction
    // ("Biscuit passed away last month") got admitted as a fact for the wrong reason.
    expect(looksLikeCodingFact('Actually, Biscuit passed away last month, I adopted a new cat named Pepper instead.')).toBe(false)
  })

  it('still flags a genuine build/test "passed"/"passing" status claim', () => {
    expect(looksLikeCodingFact('the build passed on the first try')).toBe(true)
    expect(looksLikeCodingFact('all tests are passing now')).toBe(true)
  })
})

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

describe('checkForContradictions', () => {
  it('returns [] without calling the LLM when there are no new beliefs', async () => {
    const llm = new StructuredOnlyLLMClient('{"contradictions":[]}')
    const result = await checkForContradictions([], [{ id: 'b1', statement: 'the user lives in Boston' }], llm)
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('returns [] without calling the LLM when every new belief looks like a coding fact', async () => {
    const llm = new StructuredOnlyLLMClient('{"contradictions":[]}')
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the build is passing' }],
      [{ id: 'b1', statement: 'the build is failing' }],
      llm,
    )
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('returns [] without calling the LLM when every new belief is a task-completion trail record', async () => {
    const llm = new StructuredOnlyLLMClient('{"contradictions":[]}')
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'Completed: Define the Q3 redesign scope' }],
      [{ id: 'b1', statement: 'Completed: Kick off the redesign' }],
      llm,
    )
    expect(result).toEqual([])
    expect(llm.calls).toBe(0)
  })

  it('calls the LLM and returns its findings when a new belief looks like a natural-language fact', async () => {
    const llm = new StructuredOnlyLLMClient(
      JSON.stringify({ contradictions: [{ beliefIds: ['b1', 'b2'], description: 'Boston and Seattle cannot both be the user\'s home city.' }] }),
    )
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the user lives in Seattle' }],
      [{ id: 'b1', statement: 'the user lives in Boston' }],
      llm,
    )
    expect(llm.calls).toBe(1)
    expect(result).toEqual([{ beliefIds: ['b1', 'b2'], description: 'Boston and Seattle cannot both be the user\'s home city.' }])
    // Both the new and existing beliefs are sent so the model can compare across the boundary.
    const [sentMessages] = llm.receivedMessages
    const userMessage = sentMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('Seattle')
    expect(userMessage).toContain('Boston')
  })

  it('returns [] on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the user lives in Seattle' }],
      [{ id: 'b1', statement: 'the user lives in Boston' }],
      llm,
    )
    expect(result).toEqual([])
  })

  it('returns [] when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await checkForContradictions(
      [{ id: 'b2', statement: 'the user lives in Seattle' }],
      [{ id: 'b1', statement: 'the user lives in Boston' }],
      llm,
    )
    expect(result).toEqual([])
  })
})
