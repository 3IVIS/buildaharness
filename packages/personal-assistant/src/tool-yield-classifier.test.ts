import { describe, it, expect } from 'vitest'
import { classifyToolYield } from './tool-yield-classifier.js'
import { wrapUntrusted } from './trust-tagging.js'

describe('classifyToolYield', () => {
  it('classifies the literal "No results found." web_search executor output as dead_end', () => {
    expect(classifyToolYield('web_search', 'No results found.')).toBe('dead_end')
  })

  it('classifies "No results found." as dead_end even after wrapUntrusted wraps it (the real pipeline shape — see resolveBatchItem)', () => {
    expect(classifyToolYield('web_search', wrapUntrusted('No results found.'))).toBe('dead_end')
  })

  it('does not treat a fetch_url result containing "No results found." as an automatic dead_end — that literal is web_search-specific', () => {
    // A page that happens to quote this phrase (e.g. a screenshot of another site's empty
    // search box) shouldn't auto-dead-end a fetch_url call the way it does for web_search.
    expect(classifyToolYield('fetch_url', 'The page footer reads: No results found. Copyright 2025.')).toBe('productive')
  })

  const realDeadEndPhrasings = [
    'There is no specific date mentioned for the open house.',
    'I cannot find any information about this event.',
    'The requested date was not found on this page.',
    'No mention of a "Tag der offenen Tür" event anywhere on the site.',
    'There is no event called "Tag der offenen Tür" listed on this calendar.',
  ]
  it.each(realDeadEndPhrasings)('classifies real dead-end phrasing from the comparison transcripts as dead_end: %s', (text) => {
    expect(classifyToolYield('fetch_url', text)).toBe('dead_end')
  })

  it('classifies a result containing an explicit, confirmed date as productive', () => {
    const text = 'The Tag der offenen Tür is on Thursday, October 2, 2025, 10:00-12:00, explicitly stated on the school website.'
    expect(classifyToolYield('fetch_url', text)).toBe('productive')
  })

  it('defaults to productive for ambiguous, non-empty text that is not a literal dead-end marker (documented false-negative-favoring asymmetry)', () => {
    const text = 'The page discusses several upcoming school events but the formatting is unclear.'
    expect(classifyToolYield('fetch_url', text)).toBe('productive')
  })

  it('defaults to productive for a real finding phrased defensively, even though this trades away some precision (documented limitation)', () => {
    const text = "We couldn't confirm the exact date, but it's likely mid-September based on prior years."
    expect(classifyToolYield('fetch_url', text)).toBe('productive')
  })
})
