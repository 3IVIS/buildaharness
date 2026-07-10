import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { classifyRisk, classifyRiskWithLLM, looksActionOriented } from './risk-classifier.js'

describe('classifyRisk', () => {
  it('flags a HIGH risk request', () => {
    expect(classifyRisk('Please delete my old invoices').riskLevel).toBe('HIGH')
  })

  it('flags a MEDIUM risk request', () => {
    expect(classifyRisk('Can you book a table for two tonight').riskLevel).toBe('MEDIUM')
  })

  it('requires approval for a reminder-shaped request that looks enumerated (bulk creation risk)', () => {
    const result = classifyRisk(
      'Remind me to: research the company, prepare answers to behavioral questions, pick out what to wear, and plan my route.',
    )
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
  })

  it('does not require approval for an ordinary single-item reminder request', () => {
    const result = classifyRisk('Remind me to call the dentist tomorrow.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(false)
  })

  it('classifies ordinary conversation as LOW', () => {
    expect(classifyRisk('What timezone is Tokyo in?').riskLevel).toBe('LOW')
  })

  it('flags a genuine purchase request using "order" as a verb', () => {
    expect(classifyRisk('Can you order me a pizza').riskLevel).toBe('HIGH')
    expect(classifyRisk('please order the parts from the supplier').riskLevel).toBe('HIGH')
  })

  it('does not flag a stated preference using "order" as a noun', () => {
    expect(classifyRisk('My favorite coffee order is an oat milk cortado.').riskLevel).toBe('LOW')
    expect(classifyRisk('My usual order was a cortado.').riskLevel).toBe('LOW')
    expect(classifyRisk('in order to finish this I need more time').riskLevel).toBe('LOW')
  })

  it('does not flag an informational statement using "order" as a noun preceded by an article/demonstrative', () => {
    // ORDER_VERB_PATTERN's lookbehind originally only excluded a possessive pronoun before
    // "order" — a definite/indefinite article or demonstrative is just as clearly a noun usage.
    expect(classifyRisk('The order arrived yesterday, thanks for the update.').riskLevel).toBe('LOW')
    expect(classifyRisk('An order came in this morning.').riskLevel).toBe('LOW')
    expect(classifyRisk('That order was wrong.').riskLevel).toBe('LOW')
  })

  it('still flags a genuine purchase request phrased with an article before "order"', () => {
    expect(classifyRisk('Please order the parts from the supplier').riskLevel).toBe('HIGH')
  })

  it('does not flag a declarative sentence reporting a third party\'s reported/hypothetical action', () => {
    // The user isn't asking the assistant to cancel or pay anything here — they're relaying
    // what someone else said they would do.
    const result = classifyRisk("My landlord said he will cancel my lease if I don't pay rent by Friday.")
    expect(result.riskLevel).not.toBe('HIGH')
  })

  it('still flags a first-person or imperative request even near reported-speech-shaped words', () => {
    expect(classifyRisk('Please cancel my gym membership.').riskLevel).toBe('HIGH')
  })

  it('flags "email"/"text" used as verbs, which the literal "send" pattern misses', () => {
    expect(classifyRisk('email the landlord about the leak').riskLevel).toBe('HIGH')
    expect(classifyRisk('text my sister that I\'ll be late').riskLevel).toBe('HIGH')
    expect(classifyRisk('Can you text him now?').riskLevel).toBe('HIGH')
  })

  it('does not flag "email"/"text" used as nouns', () => {
    expect(classifyRisk('check my email').riskLevel).toBe('LOW')
    expect(classifyRisk('reply to that text').riskLevel).toBe('LOW')
    expect(classifyRisk('an email came in this morning').riskLevel).toBe('LOW')
    expect(classifyRisk('the text message says he is running late').riskLevel).toBe('LOW')
    expect(classifyRisk('what is my email address').riskLevel).toBe('LOW')
    expect(classifyRisk('I got a text from him').riskLevel).toBe('LOW')
  })

  it('does not flag "text"/"order" as nouns preceded by a bare quantifier (no/any/some/every/each)', () => {
    // h1/h2: the determiner-exclusion lookbehind originally only covered possessives/articles/
    // demonstratives — bare quantifiers are the same noun-signaling shape.
    expect(classifyRisk("There's no text from him yet, so I'll just wait a bit longer.").riskLevel).toBe('LOW')
    expect(classifyRisk("Every order I've placed with them this year has been late.").riskLevel).toBe('LOW')
    expect(classifyRisk('There is no order confirmation yet.').riskLevel).toBe('LOW')
  })

  it('does not flag a present-tense yes/no question about a HIGH-risk-keyword topic', () => {
    // h3: PAST_TENSE_QUESTION's auxiliary list originally only covered past-tense/completed
    // auxiliaries (did/was/were/has/have) — "does"/"do" is the same question shape, present tense.
    const result = classifyRisk('Does this subscription cancel automatically after the 30-day trial, or do I need to do something?')
    expect(result.riskLevel).not.toBe('HIGH')
  })

  it('does not flag reported third-party speech using a "plans to"/"is going to" continuation instead of a bare modal', () => {
    // h8: REPORTED_THIRD_PARTY_SPEECH originally required a bare modal ('ll/will/would/might/could)
    // immediately after the third-person subject.
    const result = classifyRisk("My roommate warned that she plans to delete our shared documents folder if we don't split the rent by Friday.")
    expect(result.riskLevel).not.toBe('HIGH')
  })

  it('flags a plural "set reminders for X, Y, and Z" bulk request instead of falling through as LOW', () => {
    // h6: REMINDER_PATTERN's fixed phrase list originally only matched the singular "set a
    // reminder" — the plural phrasing never matched at all, skipping both ordinary MEDIUM
    // classification and the bulk-reminder confirmation gate below.
    const result = classifyRisk('Set reminders for calling the bank, emailing the landlord, and picking up dry cleaning.')
    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
  })
})

describe('looksActionOriented', () => {
  it('flags a paraphrased action request classifyRisk misses', () => {
    expect(looksActionOriented('Can you get rid of my old invoices for me')).toBe(true)
    expect(looksActionOriented('go ahead and renew it')).toBe(true)
    expect(looksActionOriented('that costs $50, can you handle it')).toBe(true)
  })

  it('does not flag ordinary conversation', () => {
    expect(looksActionOriented('What timezone is Tokyo in?')).toBe(false)
    expect(looksActionOriented('hello, how are you')).toBe(false)
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

class ThrowingLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    throw new Error('proxy unreachable')
  }
}

describe('classifyRiskWithLLM', () => {
  it('adopts the LLM verdict when it flags HIGH risk', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'HIGH', reason: 'wires money to a third party' }))

    const result = await classifyRiskWithLLM('wire that over to them', llm)

    expect(result).toEqual({ riskLevel: 'HIGH', requiresApproval: true, reason: 'wires money to a third party' })
    expect(llm.calls).toBe(1)
  })

  it('adopts the LLM verdict when it says LOW', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'LOW', reason: 'just asking a question' }))

    const result = await classifyRiskWithLLM('for me, what time is it', llm)

    expect(result).toEqual({ riskLevel: 'LOW', requiresApproval: false, reason: 'just asking a question' })
  })

  it('falls back to LOW on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')

    expect(await classifyRiskWithLLM('anything', llm)).toEqual({
      riskLevel: 'LOW',
      requiresApproval: false,
      reason: 'Conversational request with no detected side effects.',
    })
  })

  it('falls back to LOW on an unrecognized riskLevel value', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'UNKNOWN' }))

    expect((await classifyRiskWithLLM('anything', llm)).riskLevel).toBe('LOW')
  })

  it('falls back to LOW when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()

    expect((await classifyRiskWithLLM('anything', llm)).riskLevel).toBe('LOW')
  })
})
