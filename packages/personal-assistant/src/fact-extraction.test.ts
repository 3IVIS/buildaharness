import { describe, it, expect } from 'vitest'
import { extractFactsFromTurn } from './fact-extraction.js'

describe('extractFactsFromTurn', () => {
  it('captures a message stating the user\'s name', () => {
    const facts = extractFactsFromTurn('My name is Ali.', 'turn:1')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('My name is Ali.')
    expect(facts[0].sourceTurn).toBe('turn:1')
  })

  it('captures a stated preference', () => {
    const facts = extractFactsFromTurn('I prefer tea over coffee.', 'turn:2')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('I prefer tea over coffee.')
  })

  it('captures an explicit "remember that" request', () => {
    const facts = extractFactsFromTurn('Remember that my flight is on Friday.', 'turn:3')
    expect(facts).toHaveLength(1)
  })

  it('returns no facts for an ordinary question', () => {
    expect(extractFactsFromTurn('What timezone is Tokyo in?', 'turn:4')).toEqual([])
  })

  it('returns no facts for a consequential request with no self-statement', () => {
    expect(extractFactsFromTurn('Please send an email to my boss telling him I quit.', 'turn:5')).toEqual([])
  })

  it('captures a build/test/service-status statement even with no personal-fact phrasing', () => {
    const facts = extractFactsFromTurn('The tests passed on the CI pipeline for the auth service.', 'turn:6')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('The tests passed on the CI pipeline for the auth service.')
  })

  it('does not capture a request/command that merely mentions a coding-domain word', () => {
    // Contains "files" (a CODING_FACT_MARKERS word) but is a request, not a claim about the
    // world — admitting it would let an imperative turn into a persisted "known fact".
    expect(extractFactsFromTurn('Please delete the old backup files in the workspace to free up space.', 'turn:7')).toEqual([])
  })

  it('does not capture a question that merely mentions a coding-domain word', () => {
    // Contains "missing" (a CODING_FACT_MARKERS word, via "missing.txt") but is a question, not
    // a claim about the world — admitting it would let a lookup turn into a persisted "known fact".
    expect(extractFactsFromTurn('What does missing.txt say?', 'turn:8')).toEqual([])
  })

  it('captures a health/dietary self-statement with no FACT_MARKERS phrasing', () => {
    // "I'm allergic to shellfish." matches none of FACT_MARKERS' identity-statement phrases
    // ("my name is", "i'm a", ...) — this was filed only as a reminder, never as a known fact,
    // until HEALTH_OR_DIETARY_MARKERS was added.
    const facts = extractFactsFromTurn("I'm allergic to shellfish.", 'turn:9')
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe("I'm allergic to shellfish.")
  })

  it('captures other health/dietary phrasings', () => {
    expect(extractFactsFromTurn('I am vegetarian.', 'turn:10')).toHaveLength(1)
    expect(extractFactsFromTurn("I don't eat pork.", 'turn:11')).toHaveLength(1)
    expect(extractFactsFromTurn('I have a peanut allergy.', 'turn:12')).toHaveLength(1)
  })

  it('captures a health/dietary fact even when a later clause in the same message is a polite request', () => {
    // "please remind me..." used to make NON_CLAIM_MARKERS reject the whole message, dropping
    // the diabetic fact stated in the first clause entirely.
    const facts = extractFactsFromTurn(
      "I'm diabetic, so please remind me to always check the sugar content before buying snacks.",
      'turn:13',
    )
    expect(facts).toHaveLength(1)

    const facts2 = extractFactsFromTurn("I'm allergic to peanuts, so please don't suggest any recipes with peanuts in them.", 'turn:14')
    expect(facts2).toHaveLength(1)
  })

  it('captures a negated correction to a previously-stated dietary/health fact', () => {
    // "not"/"no longer" used to break adjacency to the marker word, silently dropping the
    // correction and leaving the stale original fact unchallenged.
    expect(extractFactsFromTurn("I'm not vegetarian anymore, I started eating meat again last month.", 'turn:15')).toHaveLength(1)
    expect(extractFactsFromTurn("I'm no longer allergic to shellfish, I got treated for it last year.", 'turn:16')).toHaveLength(1)
  })

  it('flags name, preference, and health/dietary facts as durable', () => {
    expect(extractFactsFromTurn('My name is Ali.', 'turn:17')[0].durable).toBe(true)
    expect(extractFactsFromTurn('Call me Ali.', 'turn:18')[0].durable).toBe(true)
    expect(extractFactsFromTurn('I prefer tea over coffee.', 'turn:19')[0].durable).toBe(true)
    expect(extractFactsFromTurn("I'm allergic to shellfish.", 'turn:20')[0].durable).toBe(true)
  })

  it('does not flag a session-scoped fact (location, job, generic "remember that") as durable', () => {
    expect(extractFactsFromTurn('I live in Seattle.', 'turn:21')[0].durable).toBe(false)
    expect(extractFactsFromTurn('I work as a nurse.', 'turn:22')[0].durable).toBe(false)
    expect(extractFactsFromTurn('Remember that my flight is on Friday.', 'turn:23')[0].durable).toBe(false)
  })
})
