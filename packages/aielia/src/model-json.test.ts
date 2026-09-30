import { describe, it, expect } from 'vitest'
import { parseModelJson } from './model-json.js'

describe('parseModelJson', () => {
  it('returns exactly what JSON.parse returns for text that already parses', () => {
    for (const text of ['{"a":1}', '[1,2,{"b":3}]', '"str"', '42', 'null', ' {"a": [1, 2]} ']) {
      expect(parseModelJson(text)).toEqual(JSON.parse(text))
    }
  })

  it('reads a reply wrapped in a code fence, with or without the json tag', () => {
    expect(parseModelJson('```json\n{"done":true}\n```')).toEqual({ done: true })
    expect(parseModelJson('```\n{"done":true}\n```')).toEqual({ done: true })
  })

  it('reads JSON behind a stray tag or a sentence of reasoning', () => {
    expect(parseModelJson('<invoke name="none">\n</invoke>\n```json\n{"reply":"ok"}\n```')).toEqual({ reply: 'ok' })
    expect(parseModelJson('Let me think about that.\n{"verdict":"grounded"}')).toEqual({ verdict: 'grounded' })
  })

  it('reads JSON followed by trailing prose', () => {
    expect(parseModelJson('{"covered":false}\n\nHope that helps!')).toEqual({ covered: false })
  })

  it('returns the whole outer object, not a nested one inside it', () => {
    const draft = { reply: 'r', tasks: [{ id: 't1' }, { id: 't2' }] }
    expect(parseModelJson('Here you go: ' + JSON.stringify(draft))).toEqual(draft)
  })

  it('skips a stray brace in surrounding prose', () => {
    expect(parseModelJson('Use the {placeholder} syntax. {"ok":true}')).toEqual({ ok: true })
  })

  it('finds a top-level array behind prose', () => {
    expect(parseModelJson('Result: [1, 2, 3]')).toEqual([1, 2, 3])
  })

  it('throws a SyntaxError when there is no JSON, like JSON.parse', () => {
    expect(() => parseModelJson('no json here')).toThrow(SyntaxError)
    expect(() => parseModelJson('{"unterminated": ')).toThrow(SyntaxError)
    expect(() => parseModelJson('')).toThrow(SyntaxError)
  })

  it('stays bounded on a reply full of opening brackets', () => {
    const started = Date.now()
    expect(() => parseModelJson('{'.repeat(5000))).toThrow(SyntaxError)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
