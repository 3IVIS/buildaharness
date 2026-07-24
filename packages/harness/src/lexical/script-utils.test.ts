import { describe, it, expect } from 'vitest'
import { containsCJK, tokenize, tokenCount, sharedTokens, splitClauses } from './script-utils.js'

describe('containsCJK', () => {
  it('detects CJK characters', () => {
    expect(containsCJK('你好')).toBe(true)
    expect(containsCJK('hello 你好')).toBe(true)
  })

  it('returns false for pure Latin, punctuation-only, or empty strings', () => {
    expect(containsCJK('hello world')).toBe(false)
    expect(containsCJK('...')).toBe(false)
    expect(containsCJK('')).toBe(false)
  })
})

describe('tokenize / tokenCount', () => {
  it('matches plain whitespace splitting for pure English text', () => {
    expect(tokenize('the login tests passed')).toEqual(['the', 'login', 'tests', 'passed'])
    expect(tokenCount('the login tests passed')).toBe(4)
  })

  it('splits each CJK character into its own token', () => {
    expect(tokenize('你好世界')).toEqual(['你', '好', '世', '界'])
    expect(tokenCount('你好世界')).toBe(4)
  })

  it('handles mixed English/CJK text, keeping English runs as whole words', () => {
    expect(tokenize('hello 你好 world')).toEqual(['hello', '你', '好', 'world'])
  })

  it('ignores extra whitespace the way split(/\\s+/).filter(Boolean) does', () => {
    expect(tokenize('  the   tests  ')).toEqual(['the', 'tests'])
  })
})

describe('sharedTokens', () => {
  it('finds shared words minus stopwords, case-insensitively', () => {
    const stopwords = new Set(['the', 'a', 'an'])
    expect(sharedTokens('The login tests passed', 'the login build failed', stopwords)).toEqual(['login'])
  })

  it('returns no overlap for two statements about unrelated things', () => {
    const stopwords = new Set(['the', 'a', 'an'])
    expect(sharedTokens('the login tests passed', 'the payment build failed', stopwords)).toEqual([])
  })

  it('works on CJK text via character-level tokens', () => {
    expect(sharedTokens('登录测试通过', '登录测试失败')).toEqual(
      expect.arrayContaining(['登', '录', '测', '试']),
    )
  })
})

describe('splitClauses', () => {
  it('reduces to a plain extraBoundary split when there is no CJK punctuation', () => {
    expect(splitClauses('a, and b', /,\s*(?:and)\b/i)).toEqual(['a', 'b'])
  })

  it('splits on CJK sentence-ending punctuation', () => {
    expect(splitClauses('第一句。第二句!第三句?')).toEqual(['第一句', '第二句', '第三句'])
  })

  it('does not split on CJK commas/enumeration commas', () => {
    expect(splitClauses('一，二、三')).toEqual(['一，二、三'])
  })
})
