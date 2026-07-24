import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { looksLikeEnumeratedItems, reframeTaskDescriptionWithLLM } from './decomposition-classifier.js'

describe('looksLikeEnumeratedItems', () => {
  it('flags a request with a sequencing marker', () => {
    expect(looksLikeEnumeratedItems('First book my flight, then reserve a hotel.')).toBe(true)
  })

  it('does not flag a short, single-step request', () => {
    expect(looksLikeEnumeratedItems('What timezone is Tokyo in?')).toBe(false)
  })

  it('flags a comma-separated enumeration with no sequencing words', () => {
    expect(
      looksLikeEnumeratedItems(
        'I have a job interview next Tuesday for a product manager role. Help me get ready: I need to research the ' +
          'company, prepare answers to behavioral questions, pick out what to wear, and plan my route so I am not late.',
      ),
    ).toBe(true)
  })

  it('flags a comma-separated enumeration ending in "or" instead of "and"', () => {
    expect(looksLikeEnumeratedItems('Could you email the landlord, text my sister, or call the plumber about the leak?')).toBe(true)
  })

  it('flags a semicolon-separated enumeration', () => {
    expect(
      looksLikeEnumeratedItems(
        'Before my interview tomorrow I need to research the company; prepare answers to common questions; iron my suit; plan my route to the office.',
      ),
    ).toBe(true)
  })

  it('flags a numbered-list enumeration with no commas and no "step" word', () => {
    expect(
      looksLikeEnumeratedItems(
        'Can you help me get ready for the move? 1. Call the moving company 2. Pack the boxes 3. Schedule a cleaning service 4. Update my mailing address.',
      ),
    ).toBe(true)
  })

  it('does not flag a single sentence containing one semicolon or a lone "N." that looks like a decimal/abbreviation', () => {
    expect(looksLikeEnumeratedItems('The meeting is at 3; let me know if that works.')).toBe(false)
    expect(looksLikeEnumeratedItems('Section 1. covers the basics.')).toBe(false)
  })

  it('flags a genuine 2-subtask request joined by exactly one semicolon and a second-task cue word', () => {
    // h5: SEMICOLON_LIST_MARKER originally required 2 semicolons (3+ items) — a genuine 2-subtask
    // request has no sequencing word, no comma-enumeration, and is short, so it fell through
    // every signal.
    expect(
      looksLikeEnumeratedItems(
        'Look up what the weather will be like in Chicago this weekend; also find me a good vegetarian restaurant nearby for Saturday night.',
      ),
    ).toBe(true)
  })

  it('flags a 3-item comma-separated list with no Oxford comma (only 1 comma before and/or)', () => {
    // h4: ENUMERATED_LIST_MARKER required 2+ commas before the closing and/or — a natural list
    // without the Oxford comma has only 1.
    expect(looksLikeEnumeratedItems('Set reminders for calling the bank, emailing the landlord and picking up dry cleaning.')).toBe(true)
    expect(looksLikeEnumeratedItems('Research the company, prepare interview answers and pick out what to wear for tomorrow.')).toBe(true)
  })

  it('does not flag an ordinary two-clause compound sentence with a single comma+and', () => {
    // The 1-comma signal must not fire on a compound sentence whose second clause reintroduces
    // its own subject right after and/or.
    expect(looksLikeEnumeratedItems('I called the bank, and it was closed for the holiday.')).toBe(false)
    expect(looksLikeEnumeratedItems("It's cold outside, and I need a coat.")).toBe(false)
  })

  it('does not flag a single reminder followed by an unrelated noun-subject aside', () => {
    expect(looksLikeEnumeratedItems("Remind me to call the bank, and my accountant's office is closed on Fridays anyway.")).toBe(false)
  })

  it('does not flag a single reminder followed by an unrelated PROPER-NOUN-subject aside', () => {
    // h6/convH: the subject-reintroduction exclusion only covered pronouns/determiners, not a name
    // — "Sarah" reintroduces the subject just as clearly as a pronoun would.
    expect(looksLikeEnumeratedItems('Remind me to call the bank, and Sarah will handle the rest of the emails.')).toBe(false)
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

  it('does not flag a single reminder followed by an unrelated thing-indefinite-pronoun-subject aside', () => {
    // batch 19, h10: same gap as the person-indefinite-pronoun case above, for a
    // thing-indefinite-pronoun ("something"/"anything"/"everything"/"nothing") subject.
    expect(
      looksLikeEnumeratedItems('Remind me to call the bank, and something came up with my car insurance too.'),
    ).toBe(false)
  })

  it('does not flag an ordinary fact+single-reminder message', () => {
    expect(looksLikeEnumeratedItems("I'm vegan, and remind me to buy oat milk on the way home tonight.")).toBe(false)
  })

  it('still flags a genuine bulk request phrased with "remind" repeated after and/or', () => {
    expect(looksLikeEnumeratedItems('Remind me to call the bank, and remind me to email the landlord about the leak.')).toBe(true)
  })

  it('flags an unpunctuated sentence-initial "First X and Y" two-step request', () => {
    // h4: SEQUENCING_MARKERS' "first[,:]" branch requires trailing punctuation — a plain
    // sentence-initial "first" with no comma/colon and no "then" fell through every signal.
    expect(looksLikeEnumeratedItems('First book the flight to Denver and reserve a rental car for the same dates.')).toBe(true)
  })

  it('does not flag "first" used mid-sentence or without a following "and"', () => {
    expect(looksLikeEnumeratedItems('This is my first time trying sushi.')).toBe(false)
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
