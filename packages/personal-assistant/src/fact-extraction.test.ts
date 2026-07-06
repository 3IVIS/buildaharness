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
})
