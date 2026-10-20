import { describe, expect, it } from 'vitest'
import { autosaveStep } from './article-autosave.js'

describe('autosaveStep', () => {
  it('does nothing while a sentence is being typed', () => {
    const a = autosaveStep('Hello wor', 'Hello worl', 0)
    expect(a.moment).toBeNull()
    expect(a.sentenceStart).toBe(0)
  })
  it('saves the text as it is once a sentence is finished', () => {
    expect(autosaveStep('Hello world', 'Hello world.', 0).moment).toBe('after')
    expect(autosaveStep('Is it?', 'Is it? Yes', 0).moment).toBeNull()
  })
  it('saves once a heading line is complete, and when a section is pasted in', () => {
    expect(autosaveStep('# Title\n\nText', '# Title\n\nText\n\n## New', 9).moment).toBeNull()
    expect(autosaveStep('# Title\n\nText\n\n## New', '# Title\n\nText\n\n## New\n', 15).moment).toBe('after')
    expect(autosaveStep('Text', 'Text\n\n## A\n\nBody', 0).moment).toBe('after')
  })
  it('saves the text as it stood when the writer starts changing another sentence', () => {
    const prev = 'First sentence. Second sentence'
    const start = autosaveStep(prev, 'First sentence. Second sentenc', 16)
    expect(start.moment).toBeNull()
    const moved = autosaveStep('First sentence. Second sentenc', 'First sentenc. Second sentenc', start.sentenceStart)
    expect(moved.moment).toBe('before')
  })
  it('does not save for changes inside the same sentence', () => {
    const a = autosaveStep('One two three', 'One two threee', 0)
    const b = autosaveStep('One two threee', 'One tw two threee', a.sentenceStart)
    expect(b.moment).toBeNull()
  })
})
