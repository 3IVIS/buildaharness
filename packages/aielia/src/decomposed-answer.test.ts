import { describe, it, expect } from 'vitest'
import { decomposedAnswerOnceEnabled } from './decomposed-answer.js'

describe('decomposedAnswerOnceEnabled', () => {
  it('is ON by default and for truthy values; OFF for falsy values', () => {
    expect(decomposedAnswerOnceEnabled({})).toBe(true)
    expect(decomposedAnswerOnceEnabled({ AUDIT_DECOMPOSED_ANSWER_ONCE: '1' })).toBe(true)
    for (const v of ['0', 'false', 'OFF', 'no', 'disabled']) expect(decomposedAnswerOnceEnabled({ AUDIT_DECOMPOSED_ANSWER_ONCE: v })).toBe(false)
  })
})
