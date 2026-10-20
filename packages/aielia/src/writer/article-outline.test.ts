import { describe, expect, it } from 'vitest'
import { outlineOf, renameHeadingInText } from './article-outline.js'

const TEXT = '# Title\n\nIntro.\n\n## One\n\nText.\n\n### One A\n\nMore.\n\n### One B\n\n## Two\n\nEnd.\n'

describe('outlineOf', () => {
  it('numbers the headings under a title and leaves the title unnumbered', () => {
    const o = outlineOf(TEXT)
    expect(o.map((e) => [e.number, e.heading])).toEqual([['', 'Title'], ['1', 'One'], ['1.1', 'One A'], ['1.2', 'One B'], ['2', 'Two']])
    expect(o[0].depth).toBe(0)
    expect(o[2].depth).toBe(2)
  })
  it('numbers from the top when there is no title', () => {
    expect(outlineOf('## A\n\n## B\n\n### C\n').map((e) => e.number)).toEqual(['1', '2', '2.1'])
  })
  it('is empty without headings and ignores the opening text', () => {
    expect(outlineOf('Just words.')).toEqual([])
  })
  it('records where each heading starts', () => {
    const o = outlineOf(TEXT)
    expect(TEXT.slice(o[1].start, o[1].start + 6)).toBe('## One')
  })
})

describe('renameHeadingInText', () => {
  it('changes the wording and keeps the level', () => {
    const at = outlineOf(TEXT)[2].start
    expect(renameHeadingInText(TEXT, at, 'Part  A')).toBe(TEXT.replace('### One A', '### Part A'))
  })
  it('keeps the text when the new wording is empty', () => {
    expect(renameHeadingInText(TEXT, outlineOf(TEXT)[1].start, '  ')).toBe(TEXT)
  })
})
