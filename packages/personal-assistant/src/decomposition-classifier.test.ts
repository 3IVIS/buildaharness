import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { classifyDecompositionCandidate, decomposeObjective, reframeTaskDescriptionWithLLM } from './decomposition-classifier.js'

describe('classifyDecompositionCandidate', () => {
  it('flags a request with a sequencing marker', () => {
    const result = classifyDecompositionCandidate('First book my flight, then reserve a hotel.')
    expect(result.isCandidate).toBe(true)
  })

  it('flags a long request even without a sequencing marker', () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ')
    expect(classifyDecompositionCandidate(long).isCandidate).toBe(true)
  })

  it('does not flag a short, single-step request', () => {
    expect(classifyDecompositionCandidate('What timezone is Tokyo in?').isCandidate).toBe(false)
  })
})

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

describe('decomposeObjective', () => {
  it('parses a well-formed multi-task response into DecomposedTaskSpecs', async () => {
    const json = JSON.stringify({
      tasks: [
        { id: 'step-1', description: 'Book the flight', depends_on: [] },
        { id: 'step-2', description: 'Book the hotel', depends_on: ['step-1'] },
      ],
    })
    const llm = new StructuredOnlyLLMClient(json)

    const tasks = await decomposeObjective(llm, 'First book a flight, then a hotel.')

    expect(tasks).toEqual([
      { id: 'step-1', description: 'Book the flight', depends_on: [] },
      { id: 'step-2', description: 'Book the hotel', depends_on: ['step-1'] },
    ])
  })

  it('returns null for a single-task response — falls back to the caller\'s own single-task graph', async () => {
    const json = JSON.stringify({ tasks: [{ id: 'only', description: 'Just do the one thing', depends_on: [] }] })
    const llm = new StructuredOnlyLLMClient(json)

    expect(await decomposeObjective(llm, 'Do the one thing.')).toBeNull()
  })

  it('returns null for malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')

    expect(await decomposeObjective(llm, 'Anything')).toBeNull()
  })

  it('returns null when the JSON is well-formed but missing the tasks field', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ notTasks: [] }))

    expect(await decomposeObjective(llm, 'Anything')).toBeNull()
  })

  it('filters out malformed task entries and returns null if fewer than 2 remain valid', async () => {
    const json = JSON.stringify({ tasks: [{ id: 'only', description: 'ok', depends_on: [] }, { id: 123, description: 'bad id' }] })
    const llm = new StructuredOnlyLLMClient(json)

    expect(await decomposeObjective(llm, 'Anything')).toBeNull()
  })
})

describe('reframeTaskDescriptionWithLLM', () => {
  it('returns the subject-first description on a well-formed response', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ description: 'the login tests: rerun after the config fix' }))

    const result = await reframeTaskDescriptionWithLLM('rerun the login tests after the config fix', llm)

    expect(result).toBe('the login tests: rerun after the config fix')
  })

  it('returns null for malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')

    expect(await reframeTaskDescriptionWithLLM('Anything', llm)).toBeNull()
  })

  it('returns null when the JSON is well-formed but missing the description field', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ notDescription: 'x' }))

    expect(await reframeTaskDescriptionWithLLM('Anything', llm)).toBeNull()
  })

  it('returns null for a blank description instead of an empty string', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ description: '   ' }))

    expect(await reframeTaskDescriptionWithLLM('Anything', llm)).toBeNull()
  })
})
