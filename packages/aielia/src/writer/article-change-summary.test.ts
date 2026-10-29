import { describe, it, expect } from 'vitest'
import { describeSectionChange, summarizeSectionChange } from './article-change-summary.js'

const doc = (...secs: [string, string][]): string => `# Post\n\n${secs.map(([h, b]) => `## ${h}\n\n${b}\n`).join('\n')}`

describe('summarizeSectionChange', () => {
  const before = doc(['Intro', 'Hello.'], ['Latency', 'It is quick.'], ['Close', 'Bye.'])

  it('finds nothing in an unchanged article', () => {
    const c = summarizeSectionChange(before, before)
    expect(c).toEqual({ outline: { added: [], removed: [], renamed: [], moved: [] }, reworded: [] })
    expect(describeSectionChange(c)).toBe('')
  })
  it('names the sections whose wording changed, and leaves the outline alone', () => {
    const c = summarizeSectionChange(before, doc(['Intro', 'Hello there.'], ['Latency', 'It is quick.'], ['Close', 'Goodbye.']))
    expect(c.outline).toEqual({ added: [], removed: [], renamed: [], moved: [] })
    expect(c.reworded).toEqual(['Intro', 'Close'])
    expect(describeSectionChange(c)).toBe('• Wording changed in “Intro”, “Close”.')
  })
  it('finds added and removed sections', () => {
    const c = summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Story', 'New.'], ['Latency', 'It is quick.'], ['Close', 'Bye.']))
    expect(c.outline.added).toEqual(['Story'])
    expect(describeSectionChange(summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Close', 'Bye.'])))).toBe('• Outline: removed “Latency”.')
  })
  it('reads a heading changed in place as a rename, and a section that changed place as moved', () => {
    const c = summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Speed', 'It is quick.'], ['Close', 'Bye.']))
    expect(c.outline.renamed).toEqual([{ from: 'Latency', to: 'Speed' }])
    expect(c.outline.added).toEqual([])
    const m = summarizeSectionChange(before, doc(['Close', 'Bye.'], ['Intro', 'Hello.'], ['Latency', 'It is quick.']))
    expect(m.outline.moved).toEqual(['Close'])
    expect(describeSectionChange(m)).toBe('• Outline: moved “Close”.')
  })
  it('puts the outline line before the wording line, and shortens long lists', () => {
    const many = doc(['A', '1'], ['B', '1'], ['C', '1'], ['D', '1'], ['E', '1'], ['F', '1'])
    const text = describeSectionChange(summarizeSectionChange(before, many))
    expect(text).toContain('• Outline: added “A”, “B”, “C”, “D” and 2 more')
    const both = describeSectionChange(summarizeSectionChange(before, doc(['Intro', 'Changed.'], ['Story', 'New.'], ['Latency', 'It is quick.'], ['Close', 'Bye.'])))
    expect(both.split('\n')).toEqual(['• Outline: added “Story”.', '• Wording changed in “Intro”.'])
  })
  it('counts text before the first heading as the opening text', () => {
    const c = summarizeSectionChange('Intro text.\n\n## A\n\nx\n', 'New intro.\n\n## A\n\nx\n')
    expect(c.reworded).toEqual(['the opening text'])
  })
})
