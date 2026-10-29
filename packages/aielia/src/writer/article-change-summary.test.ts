import { describe, it, expect } from 'vitest'
import { NAME_CLOSE, NAME_OPEN, describeSectionChange as describeMarked, summarizeSectionChange } from './article-change-summary.js'

/** The text with the name marks shown as “…”, as the tests were written. */
const describe_ = (c: ReturnType<typeof summarizeSectionChange>): string => describeMarked(c).split(NAME_OPEN).join('“').split(NAME_CLOSE).join('”')
const doc = (...secs: [string, string][]): string => `# Post\n\n${secs.map(([h, b]) => `## ${h}\n\n${b}\n`).join('\n')}`

describe('summarizeSectionChange', () => {
  const before = doc(['Intro', 'Hello.'], ['Latency', 'It is quick.'], ['Close', 'Bye.'])

  it('finds nothing in an unchanged article', () => {
    const c = summarizeSectionChange(before, before)
    expect(c).toEqual({ outline: { added: [], removed: [], renamed: [], moved: [] }, addedWithText: [], reworded: [], how: {} })
    expect(describe_(c)).toBe('')
  })
  it('names the sections whose wording changed, and leaves the outline alone', () => {
    const base = doc(['Intro', 'The p99 latency was measured over one week of traffic.'], ['Latency', 'It is quick.'], ['Close', 'The result held across every region we tried.'])
    const c = summarizeSectionChange(base, doc(['Intro', 'The p99 latency was measured across one week of traffic.'], ['Latency', 'It is quick.'], ['Close', 'The result held across every region we tested.']))
    expect(c.outline).toEqual({ added: [], removed: [], renamed: [], moved: [] })
    expect(c.reworded).toEqual(['Intro', 'Close'])
    expect(describe_(c)).toBe('• Reworded: “Intro”, “Close”.')
  })
  it('says what was done to a section: rewrote, wrote, added to, shortened', () => {
    const base = doc(['A', 'A brief description of what it is and the core problem it solves.'], ['B', ''], ['C', 'Short note on the result of the test run.'], ['D', 'One two three four five six seven eight nine ten eleven twelve.'])
    const next = doc(['A', 'Who does not love free stuff? We wrote in ChatGPT and pasted into Word, and it worked until it did not.'], ['B', 'We measured it twice.'], ['C', 'Short note on the result of the test run. It held in every region we tried, including the slowest.'], ['D', 'One two three four five six seven.'])
    const c = summarizeSectionChange(base, next)
    expect(c.how).toEqual({ A: 'rewrote', B: 'wrote', C: 'added to', D: 'shortened' })
    expect(describe_(c).split('\n')).toEqual(['• Rewrote: “A”.', '• Wrote: “B”.', '• Added to: “C”.', '• Shortened: “D”.'])
  })
  it('finds added and removed sections', () => {
    const c = summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Story', 'New.'], ['Latency', 'It is quick.'], ['Close', 'Bye.']))
    expect(c.outline.added).toEqual(['Story'])
    expect(describe_(summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Close', 'Bye.'])))).toBe('• Outline: removed “Latency”.')
  })
  it('reads a heading changed in place as a rename, and a section that changed place as moved', () => {
    const c = summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Speed', 'It is quick.'], ['Close', 'Bye.']))
    expect(c.outline.renamed).toEqual([{ from: 'Latency', to: 'Speed' }])
    expect(c.outline.added).toEqual([])
    const m = summarizeSectionChange(before, doc(['Close', 'Bye.'], ['Intro', 'Hello.'], ['Latency', 'It is quick.']))
    expect(m.outline.moved).toEqual(['Close'])
    expect(describe_(m)).toBe('• Outline: moved “Close”.')
  })
  it('puts the outline line before the wording line, and shortens long lists', () => {
    const many = doc(['A', '1'], ['B', '1'], ['C', '1'], ['D', '1'], ['E', '1'], ['F', '1'])
    const text = describe_(summarizeSectionChange(before, many))
    expect(text).toContain('• Outline: added “A”, “B”, “C”, “D” and 2 more')
    const both = describe_(summarizeSectionChange(before, doc(['Intro', 'Hello there, friend.'], ['Story', 'New.'], ['Latency', 'It is quick.'], ['Close', 'Bye.'])))
    expect(both.split('\n')).toEqual(['• Outline: added “Story”, with text.', '• Added to: “Intro”.'])
  })
  it('counts text before the first heading as the opening text', () => {
    const c = summarizeSectionChange('Intro text.\n\n## A\n\nx\n', 'New intro.\n\n## A\n\nx\n')
    expect(c.reworded).toEqual(['the opening text'])
  })
  it('says when an added section came with text', () => {
    const c = summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Why not others', 'Other tools fall short.'], ['Latency', 'It is quick.'], ['Close', 'Bye.']))
    expect(c.addedWithText).toEqual(['Why not others'])
    expect(describe_(c)).toBe('• Outline: added “Why not others”, with text.')
    const bare = summarizeSectionChange(before, doc(['Intro', 'Hello.'], ['Why not others', ''], ['Latency', 'It is quick.'], ['Close', 'Bye.']))
    expect(describe_(bare)).toBe('• Outline: added “Why not others”.')
  })
})
