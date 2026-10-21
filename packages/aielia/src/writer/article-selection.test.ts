import { describe, it, expect } from 'vitest'
import { expandSelection } from './article-selection.js'

const MD = 'Intro line.\n\n# Post\n\nFirst one. The p99 was 18 ms. Last one.\nSame paragraph.\n\n## Latency\n\nIt is quick here.\n\n## Cost\n\nCheap.\n'
const grow = (start: number, end = start): string[] => {
  const out: string[] = []
  let r = { start, end }
  for (let i = 0; i < 6; i++) {
    const n = expandSelection(MD, r)
    if (!n) break
    out.push(`${n.unit}: ${MD.slice(n.range.start, n.range.end).replace(/\n/g, '⏎')}`)
    r = n.range
  }
  return out
}

describe('growing a selection', () => {
  it('goes from the cursor to the sentence, paragraph, section and article', () => {
    const steps = grow(MD.indexOf('18 ms'))
    expect(steps).toEqual([
      'sentence: The p99 was 18 ms.',
      'paragraph: First one. The p99 was 18 ms. Last one.⏎Same paragraph.',
      'section: # Post⏎⏎First one. The p99 was 18 ms. Last one.⏎Same paragraph.⏎⏎## Latency⏎⏎It is quick here.⏎⏎## Cost⏎⏎Cheap.',
      expect.stringMatching(/^article: Intro line\./),
    ])
  })
  it('a subsection ends at the next heading of its level, and a word grows to its sentence', () => {
    expect(grow(MD.indexOf('quick'), MD.indexOf('quick') + 5)[0]).toBe('sentence: It is quick here.')
    // the sentence is also the whole paragraph, so the next step up is the section
    expect(grow(MD.indexOf('quick'))[1]).toBe('section: ## Latency⏎⏎It is quick here.')
  })
  it('several sentences grow to the paragraph; text before the first heading is a section; nothing grows past the article', () => {
    const a = MD.indexOf('First one.')
    const b = MD.indexOf('Last one.') + 'Last one.'.length
    expect(expandSelection(MD, { start: a, end: b })?.unit).toBe('paragraph')
    const preface = 'Intro one.\n\nIntro two.\n\n# H\n\nBody.\n'
    const unit = (r: { start: number; end: number }): string | undefined => expandSelection(preface, r)?.unit
    const para = expandSelection(preface, { start: 2, end: 2 })!.range
    expect(unit({ start: 2, end: 2 })).toBe('sentence')
    expect(unit(para)).toBe('section')
    expect(expandSelection(MD, { start: 0, end: MD.length })).toBeUndefined()
    expect(expandSelection('', { start: 0, end: 0 })).toBeUndefined()
  })
})

describe('growing without the whole article', () => {
  const steps = (text: string, at: number): string[] => {
    const out: string[] = []
    let r = { start: at, end: at }
    for (let i = 0; i < 8; i++) {
      const n = expandSelection(text, r, { wholeArticle: false })
      if (!n) break
      out.push(n.unit)
      r = n.range
    }
    return out
  }
  it('climbs through every section above the text and stops one short of the whole article', () => {
    const nested = 'Intro.\n\n# Post\n\nBody here.\n\n## Latency\n\n### Detail\n\nA deep sentence.\n\n## Cost\n\nCheap.\n'
    // sentence, then the ### section, the ## section, the # section; the article (with the intro) is not offered
    expect(steps(nested, nested.indexOf('deep'))).toEqual(['sentence', 'section', 'section', 'section'])
  })
  it('a section that is the whole article is not offered either', () => {
    const only = '# Post\n\nOne sentence here. Another one.\n\n## Part\n\nText.\n'
    // the # section is the whole article, so the ## section is the largest
    expect(steps(only, only.indexOf('Text'))).toEqual(['sentence', 'section'])
    expect(steps('Just one sentence.', 3)).toEqual([])
  })
})
