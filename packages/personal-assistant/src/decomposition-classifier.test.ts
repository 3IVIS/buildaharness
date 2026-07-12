import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { classifyDecompositionCandidate, decomposeObjective, looksLikeEnumeratedItems, reframeTaskDescriptionWithLLM } from './decomposition-classifier.js'

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

  it('does not flag a compound sentence whose second clause reintroduces a new NOUN subject (not a pronoun)', () => {
    // h8: ONE_COMMA_LIST_MARKER's subject-reintroduction exclusion only covered pronouns.
    expect(
      classifyDecompositionCandidate("Remind me to call the bank, and my accountant's office is closed on Fridays anyway.").isCandidate,
    ).toBe(false)
  })

  it('does not flag a compound sentence whose second clause reintroduces a new PROPER-NOUN subject', () => {
    // h6/convH: the subject-reintroduction exclusion only covered pronouns/determiners, not a name
    // — "Sarah" reintroduces the subject just as clearly as a pronoun would.
    expect(classifyDecompositionCandidate('Remind me to call the bank, and Sarah will handle the rest of the emails.').isCandidate).toBe(
      false,
    )
  })

  it('does not flag a compound sentence whose second clause reintroduces an INDEFINITE-PRONOUN subject', () => {
    // h9: the subject-reintroduction exclusion covered exact pronoun/determiner tokens but not
    // indefinite pronouns like "someone"/"everybody"/"anybody".
    expect(
      classifyDecompositionCandidate('Remind me to call the bank, and someone will follow up separately about the wire transfer paperwork.')
        .isCandidate,
    ).toBe(false)
  })

  it('flags an unpunctuated sentence-initial "First X and Y" two-step request', () => {
    // h4: SEQUENCING_MARKERS' "first[,:]" branch requires trailing punctuation — a plain
    // sentence-initial "first" with no comma/colon and no "then" fell through every signal.
    const result = classifyDecompositionCandidate('First book the flight to Denver and reserve a rental car for the same dates.')
    expect(result.isCandidate).toBe(true)
  })

  it('does not flag "first" used mid-sentence or without a following "and"', () => {
    expect(classifyDecompositionCandidate('This is my first time trying sushi.').isCandidate).toBe(false)
  })
})

describe('looksLikeEnumeratedItems', () => {
  it('does not flag a single reminder followed by an unrelated noun-subject aside', () => {
    expect(looksLikeEnumeratedItems("Remind me to call the bank, and my accountant's office is closed on Fridays anyway.")).toBe(false)
  })

  it('does not flag a single reminder followed by an unrelated indefinite-pronoun-subject aside', () => {
    // h9: same gap as the noun/proper-noun cases above, for an indefinite pronoun subject.
    expect(
      looksLikeEnumeratedItems('Remind me to call the bank, and someone will follow up separately about the wire transfer paperwork.'),
    ).toBe(false)
  })

  it('does not flag a single reminder followed by an unrelated existential-"there" aside', () => {
    // batch 10 re-probe (conv166/h10): same gap as the noun/proper-noun/indefinite-pronoun cases
    // above, for an existential "there" subject.
    expect(looksLikeEnumeratedItems("Remind me to call the bank, and there's a package coming today too.")).toBe(false)
  })

  it('does not flag an ordinary fact+single-reminder message', () => {
    expect(looksLikeEnumeratedItems("I'm vegan, and remind me to buy oat milk on the way home tonight.")).toBe(false)
  })

  it('still flags a genuine bulk request phrased with "remind" repeated after and/or', () => {
    expect(looksLikeEnumeratedItems('Remind me to call the bank, and remind me to email the landlord about the leak.')).toBe(true)
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
