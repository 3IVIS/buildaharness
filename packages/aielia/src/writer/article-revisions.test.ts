import { describe, expect, it } from 'vitest'
import { revisionsOfText } from './article-revisions.js'

const v = (index: number, markdown: string) => ({ index, kind: 'checkpoint', at: `2026-10-0${index + 1}T10:00:00Z`, markdown })

describe('revisionsOfText', () => {
  it('lists how a sentence read in earlier versions, newest first, skipping versions where it did not change', () => {
    const now = '# T\n\nThe tool is fast. It runs everywhere on every machine.\n'
    const at = now.indexOf('It runs')
    const r = revisionsOfText(now, { start: at, end: at }, [
      v(0, '# T\n\nThe tool is fast. It runs on some machines.\n'),
      v(1, '# T\n\nThe tool is fast. It runs on some machines.\n'),
      v(2, '# T\n\nThe tool is fast. It runs everywhere on every machine.\n'),
    ])
    expect(r?.unit).toBe('sentence')
    expect(r?.revisions.map((x) => x.text)).toEqual(['It runs everywhere on every machine.', 'It runs on some machines.'])
    expect(r?.revisions[1].index).toBe(1)
  })
  it('says the piece was not there when no sentence resembles it', () => {
    const now = 'Alpha beta gamma delta.\n'
    const r = revisionsOfText(now, { start: 2, end: 2 }, [v(0, 'Completely unrelated words here.\n')])
    expect(r?.revisions[1].text).toBeUndefined()
  })
  it('follows a whole section', () => {
    const now = '# T\n\n## One\n\nNew words about cats and dogs.\n\n## Two\n\nOther.\n'
    const at = now.indexOf('## One')
    const r = revisionsOfText(now, { start: at, end: now.indexOf('\n\n## Two') }, [v(0, '# T\n\n## One\n\nOld words about cats and dogs.\n\n## Two\n\nOther.\n')])
    expect(r?.unit).toBe('section')
    expect(r?.revisions[1].text).toContain('Old words')
  })
  it('another sentence of the paragraph is not an earlier wording of the picked one: when the picked one was new, it was not there', () => {
    const now = '# T\n\nLatency is low. The p99 latency is low on all machines.\n'
    const at = now.indexOf('The p99')
    const r = revisionsOfText(now, { start: at, end: at }, [v(0, '# T\n\nLatency is low.\n')])
    expect(r?.revisions.map((x) => x.text)).toEqual(['The p99 latency is low on all machines.', undefined])
    expect(r?.revisions[1].index).toBe(0)
  })
  it('finds a sentence that has a number with a point in it or runs over a line break, as the selection does', () => {
    const now = '# T\n\nVersion 1.2 shipped in May. The p99 fell to 18 ms.\n'
    const at = now.indexOf('Version')
    const r = revisionsOfText(now, { start: at, end: at }, [v(0, '# T\n\nVersion 1.2 shipped in June. The p99 fell to 18 ms.\n')])
    expect(r?.revisions.map((x) => x.text)).toEqual(['Version 1.2 shipped in May.', 'Version 1.2 shipped in June.'])
  })
})
