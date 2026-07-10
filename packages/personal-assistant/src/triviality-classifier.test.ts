import { describe, it, expect } from 'vitest'
import { classifyTriviality } from './triviality-classifier.js'

describe('classifyTriviality', () => {
  it('treats a short self-contained factual question as trivial', () => {
    const result = classifyTriviality('What timezone is Tokyo in?', 'LOW')
    expect(result.isTrivial).toBe(true)
  })

  it('treats a simple yes/no factual question as trivial', () => {
    const result = classifyTriviality('Is Paris the capital of France?', 'LOW')
    expect(result.isTrivial).toBe(true)
  })

  it('never treats a MEDIUM-risk request as trivial', () => {
    const result = classifyTriviality('What time should I schedule the reminder for?', 'MEDIUM')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/not LOW risk/)
  })

  it('never treats a HIGH-risk request as trivial', () => {
    const result = classifyTriviality('What happens if I delete this file?', 'HIGH')
    expect(result.isTrivial).toBe(false)
  })

  it('rejects long requests even if they open with an interrogative', () => {
    const long = 'What is the most efficient way to plan a multi-city trip across Europe next spring given a limited budget?'
    const result = classifyTriviality(long, 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/too long/)
  })

  it('rejects requests that reference prior conversation', () => {
    const result = classifyTriviality('Is Tokyo still 9 hours ahead like you said earlier?', 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/prior conversation/)
  })

  it('rejects a non-factual-shaped request even when it also references prior conversation', () => {
    const result = classifyTriviality('Earlier you said Tokyo was 9 hours ahead — is that right?', 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/not a self-contained factual question/)
  })

  it('rejects requests asking for generated or reasoned content', () => {
    const result = classifyTriviality('What is the best way to invest $10,000?', 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/reasoning or generated content/)
  })

  it('rejects a compound / multi-question request', () => {
    const result = classifyTriviality('What time is it in Tokyo? What about London?', 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/compound/)
  })

  it('rejects a compound question joined by a bare "and" with only one trailing "?"', () => {
    // Neither "and also" nor a second "?" appears here, but this is just as much a two-fact
    // compound question as the double-"?" case above.
    const result = classifyTriviality("What's the capital of France and what's the capital of Germany?", 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/compound/)
  })

  it("rejects requests that don't open with a factual-question shape", () => {
    const result = classifyTriviality('Tell me something interesting about Tokyo.', 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/not a self-contained factual question/)
  })

  it('rejects a compound question joined by bare "and how" (not just "and how many/how much")', () => {
    // h7: COMPOUND_MARKERS' third branch only recognized "how many"/"how much" after "and",
    // not bare "how" ("and how does...").
    const result = classifyTriviality("What's the boiling point of water and how does altitude affect it?", 'LOW')
    expect(result.isTrivial).toBe(false)
    expect(result.reason).toMatch(/compound/)
  })
})
