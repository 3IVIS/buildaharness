import { describe, expect, it } from 'vitest'
import { outlineOf, renameHeadingInText, outlineToText, applyOutlineText } from './article-outline.js'

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

describe('outline as text', () => {
  const T = '# Title\n\nIntro.\n\n## One\n\nText one.\n\n### One A\n\nMore.\n\n## Two\n\nEnd.\n'
  it('is the headings, one per line, as written in the article', () => {
    expect(outlineToText(T)).toBe('# Title\n## One\n### One A\n## Two')
  })
  it('leaves the article untouched when the outline is unchanged', () => {
    expect(applyOutlineText(T, outlineToText(T))).toBe(T)
  })
  it('rewording a line rewords the heading and keeps its text', () => {
    expect(applyOutlineText(T, '# Title\n## First\n### One A\n## Two')).toBe(T.replace('## One', '## First'))
  })
  it('a new line is a new empty section, a line without hashes joins the level above', () => {
    expect(applyOutlineText(T, '# Title\n## One\n### One A\n### One B\nOne C\n## Two')).toBe(T.replace('## Two', '### One B\n\n### One C\n\n## Two'))
  })
  it('a new subsection is typed with more hashes', () => {
    expect(applyOutlineText(T, '# Title\n## One\n### One A\n#### Deeper\n## Two')).toBe(T.replace('## Two', '#### Deeper\n\n## Two'))
  })
  it('changing the hashes changes the level and keeps the text', () => {
    expect(applyOutlineText(T, '# Title\n## One\n## One A\n## Two')).toBe(T.replace('### One A', '## One A'))
  })
  it('deleting a line removes the heading only; its text stays with the section above', () => {
    const out = applyOutlineText(T, '# Title\n## One\n## Two')
    expect(out).not.toContain('One A')
    expect(out).toContain('More.')
    expect(out.indexOf('More.')).toBeLessThan(out.indexOf('## Two'))
  })
  it('moving a line moves its section', () => {
    const out = applyOutlineText(T, '# Title\n## Two\n## One\n### One A')
    expect(out.indexOf('## Two')).toBeLessThan(out.indexOf('## One'))
    expect(out.indexOf('End.')).toBeLessThan(out.indexOf('Text one.'))
    expect(out.indexOf('Text one.')).toBeLessThan(out.indexOf('More.'))
  })
  it('waits while a line is only hashes', () => {
    expect(applyOutlineText(T, '# Title\n## One\n##\n## Two')).toBe(T)
  })
})
