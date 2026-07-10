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

  it('flags a comma-separated enumeration with no sequencing words and under the word limit', () => {
    const result = classifyDecompositionCandidate(
      'I have a job interview next Tuesday for a product manager role. Help me get ready: I need to research the ' +
        'company, prepare answers to behavioral questions, pick out what to wear, and plan my route so I am not late.',
    )
    expect(result.isCandidate).toBe(true)
  })

  it('flags a comma-separated enumeration ending in "or" instead of "and"', () => {
    const result = classifyDecompositionCandidate('Could you email the landlord, text my sister, or call the plumber about the leak?')
    expect(result.isCandidate).toBe(true)
  })

  it('flags a semicolon-separated enumeration', () => {
    const result = classifyDecompositionCandidate(
      'Before my interview tomorrow I need to research the company; prepare answers to common questions; iron my suit; plan my route to the office.',
    )
    expect(result.isCandidate).toBe(true)
  })

  it('flags a numbered-list enumeration with no commas and no "step" word', () => {
    const result = classifyDecompositionCandidate(
      'Can you help me get ready for the move? 1. Call the moving company 2. Pack the boxes 3. Schedule a cleaning service 4. Update my mailing address.',
    )
    expect(result.isCandidate).toBe(true)
  })

  it('does not flag a single sentence containing one semicolon or a lone "N." that looks like a decimal/abbreviation', () => {
    expect(classifyDecompositionCandidate('The meeting is at 3; let me know if that works.').isCandidate).toBe(false)
    expect(classifyDecompositionCandidate('Section 1. covers the basics.').isCandidate).toBe(false)
  })

  it('flags a genuine 2-subtask request joined by exactly one semicolon and a second-task cue word', () => {
    // h5: SEMICOLON_LIST_MARKER originally required 2 semicolons (3+ items) — a genuine 2-subtask
    // request has no sequencing word, no comma-enumeration, and is short enough to dodge
    // WORD_LIMIT, so it fell through every signal.
    const result = classifyDecompositionCandidate(
      'Look up what the weather will be like in Chicago this weekend; also find me a good vegetarian restaurant nearby for Saturday night.',
    )
    expect(result.isCandidate).toBe(true)
  })

  it('flags a 3-item comma-separated list with no Oxford comma (only 1 comma before and/or)', () => {
    // h4: ENUMERATED_LIST_MARKER required 2+ commas before the closing and/or — a natural list
    // without the Oxford comma has only 1.
    expect(classifyDecompositionCandidate('Set reminders for calling the bank, emailing the landlord and picking up dry cleaning.').isCandidate).toBe(
      true,
    )
    expect(
      classifyDecompositionCandidate('Research the company, prepare interview answers and pick out what to wear for tomorrow.').isCandidate,
    ).toBe(true)
  })

  it('does not flag an ordinary two-clause compound sentence with a single comma+and', () => {
    // The new 1-comma signal must not fire on a compound sentence whose second clause
    // reintroduces its own subject right after and/or.
    expect(classifyDecompositionCandidate('I called the bank, and it was closed for the holiday.').isCandidate).toBe(false)
    expect(classifyDecompositionCandidate("It's cold outside, and I need a coat.").isCandidate).toBe(false)
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
