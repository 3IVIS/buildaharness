import { describe, it, expect } from 'vitest'
import type { AskQuestion } from '@buildaharness/harness'
import { emptyDraft, orderedOptions, draftToAnswer } from './ask-draft.js'

const question = (options?: AskQuestion['options']): AskQuestion => ({ id: 'q1', header: 'h', question: 'which?', allowMultiple: false, options } as AskQuestion)

describe('orderedOptions', () => {
  it('puts recommended options first and keeps the rest in order', () => {
    const q = question([{ label: 'a' }, { label: 'b', recommended: true }, { label: 'c' }, { label: 'd', recommended: true }])
    expect(orderedOptions(q).map((o) => o.label)).toEqual(['b', 'd', 'a', 'c'])
  })
  it('returns an empty list when the question has no options', () => {
    expect(orderedOptions(question())).toEqual([])
  })
})

describe('draftToAnswer', () => {
  it('is null for an empty draft and for whitespace-only free text', () => {
    expect(draftToAnswer('q1', emptyDraft())).toBeNull()
    expect(draftToAnswer('q1', { ...emptyDraft(), freeText: '   ' })).toBeNull()
  })
  it('answers a selection', () => {
    expect(draftToAnswer('q1', { ...emptyDraft(), selectedLabels: ['a'] })).toEqual({ questionId: 'q1', kind: 'selected', selectedLabels: ['a'] })
  })
  it('adds a trimmed note to a selection when showEdit is unset (CLI) or true (card)', () => {
    const expected = { questionId: 'q1', kind: 'selected_with_edit', selectedLabels: ['a'], editText: 'note' }
    expect(draftToAnswer('q1', { ...emptyDraft(), selectedLabels: ['a'], editText: ' note ' })).toEqual(expected)
    expect(draftToAnswer('q1', { ...emptyDraft(), selectedLabels: ['a'], editText: ' note ', showEdit: true })).toEqual(expected)
  })
  it('ignores a note the card has hidden (showEdit false)', () => {
    expect(draftToAnswer('q1', { ...emptyDraft(), selectedLabels: ['a'], editText: 'note', showEdit: false })).toEqual({ questionId: 'q1', kind: 'selected', selectedLabels: ['a'] })
  })
  it('answers free text, and a selection wins over free text', () => {
    expect(draftToAnswer('q1', { ...emptyDraft(), freeText: ' hi ' })).toEqual({ questionId: 'q1', kind: 'free_text', freeText: 'hi' })
    expect(draftToAnswer('q1', { ...emptyDraft(), selectedLabels: ['a'], freeText: 'hi' })).toMatchObject({ kind: 'selected' })
  })
})
