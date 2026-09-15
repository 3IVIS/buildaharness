import { describe, it, expect } from 'vitest'

import {
  makeSurfaceBlocker,
  makeQuestionsBatch,
  validateAskQuestion,
  validateAskAnswer,
  validateAskResponse,
  batchQuestions,
  refineDeferredBatch,
  type AskQuestion,
  type AskAnswer,
  type AskResponse,
} from './escalate.js'

// ─── Q0: shared question/answer types, both twins, inert ──────────────────────
// Nothing in this file constructs a populated `questions` field outside test
// fixtures — no behavior change is possible at this phase (see plan Q0).

describe('SurfaceBlocker — INV-26 (old shape stays byte-identical)', () => {
  it('a blocker built without questions has no questions key at all', () => {
    const blocker = makeSurfaceBlocker('cannot_make_progress', ['need more context'], 'stuck task')
    expect(blocker.questions).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(blocker, 'questions')).toBe(false)
    expect(JSON.parse(JSON.stringify(blocker))).not.toHaveProperty('questions')
  })
})

describe('SurfaceBlocker — a 4-question batch mixing all three answer kinds', () => {
  const questions: AskQuestion[] = [
    {
      id: 'q1',
      question: 'Pick a color',
      options: [
        { label: 'Red' },
        { label: 'Blue', recommended: true },
      ],
    },
    {
      id: 'q2',
      question: 'Pick as many as apply',
      allowMultiple: true,
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    },
    {
      id: 'q3',
      question: 'Free text only, no options',
    },
    {
      id: 'q4',
      question: 'One with a preview',
      options: [{ label: 'X', preview: 'preview text' }, { label: 'Y' }],
    },
  ]

  it('round-trips through the blocker and JSON serialization unchanged', () => {
    const blocker = makeSurfaceBlocker('supervisor_question', [], 'drafting', questions)
    const restored = JSON.parse(JSON.stringify(blocker)) as typeof blocker
    expect(restored.questions).toHaveLength(4)
    expect(restored.questions?.[1].allowMultiple).toBe(true)
    expect(restored.questions?.[2].options).toBeUndefined()
    expect(restored.questions?.[3].options?.[0].preview).toBe('preview text')
  })

  it('validates a full AskResponse against the batch, all three answer kinds', () => {
    const response: AskResponse = {
      answers: [
        { questionId: 'q1', kind: 'selected', selectedLabels: ['Blue'] },
        { questionId: 'q2', kind: 'selected', selectedLabels: ['A', 'C'] },
        { questionId: 'q3', kind: 'free_text', freeText: 'hello' },
        { questionId: 'q4', kind: 'selected_with_edit', selectedLabels: ['X'], editText: 'but faster' },
      ],
    }
    expect(() => validateAskResponse(questions, response)).not.toThrow()
  })
})

describe('construction-time rejection of invalid combinations', () => {
  it('rejects preview combined with allowMultiple', () => {
    expect(() =>
      validateAskQuestion({
        id: 'bad',
        question: 'x',
        allowMultiple: true,
        options: [{ label: 'A', preview: 'p' }, { label: 'B' }],
      }),
    ).toThrow(/preview.*allowMultiple/)
  })

  it('rejects a 1-option array', () => {
    expect(() => validateAskQuestion({ id: 'bad', question: 'x', options: [{ label: 'A' }] })).toThrow(
      /between 2 and 4/,
    )
  })

  it('rejects a 5-option array', () => {
    expect(() =>
      validateAskQuestion({
        id: 'bad',
        question: 'x',
        options: [1, 2, 3, 4, 5].map((n) => ({ label: String(n) })),
      }),
    ).toThrow(/between 2 and 4/)
  })

  it('rejects a 5th question in a single batch', () => {
    const fiveQuestions: AskQuestion[] = [1, 2, 3, 4, 5].map((n) => ({ id: `q${n}`, question: `question ${n}` }))
    expect(() => makeQuestionsBatch(fiveQuestions)).toThrow(/4-question cap/)
    expect(() => makeSurfaceBlocker('cannot_make_progress', [], 'x', fiveQuestions)).toThrow(/4-question cap/)
  })

  it('rejects an answer kind whose data does not match its own shape', () => {
    const mismatched = { questionId: 'q1', kind: 'free_text', selectedLabels: ['A'] } as unknown as AskAnswer
    // freeText is missing entirely for a `free_text` kind — this is the shape the
    // validator actually enforces (see validateAskAnswer), not just cross-referencing
    // against a question.
    expect(() => validateAskAnswer(mismatched)).toThrow(/free_text.*non-empty freeText/)
  })

  it('rejects an allowMultiple: false question receiving more than one selected label', () => {
    const q: AskQuestion[] = [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }]
    const response: AskResponse = {
      answers: [{ questionId: 'q1', kind: 'selected', selectedLabels: ['A', 'B'] }],
    }
    expect(() => validateAskResponse(q, response)).toThrow(/does not allow multiple selections/)
  })

  it('rejects a resolve payload missing an answer for a question', () => {
    const q: AskQuestion[] = [
      { id: 'q1', question: 'Pick one' },
      { id: 'q2', question: 'Pick another' },
    ]
    const response: AskResponse = { answers: [{ questionId: 'q1', kind: 'free_text', freeText: 'ok' }] }
    expect(() => validateAskResponse(q, response)).toThrow(/missing answers.*q2/)
  })
})

describe('INV-37 — sequential batching for more than 4 candidate questions', () => {
  const candidates: AskQuestion[] = Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`,
    question: `candidate ${i}`,
  }))

  it('batches the top-ranked 4 and returns the rest as an ordered, unconstructed deferred list', () => {
    const { batch, deferred } = batchQuestions(candidates)
    expect(batch.map((q) => q.id)).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(deferred.map((q) => q.id)).toEqual(['c4', 'c5', 'c6'])
    // batch two of 3 never gets rejected the way a 5th question in ONE batch would —
    // it's still a valid, separately-constructible batch.
    expect(() => makeQuestionsBatch(deferred)).not.toThrow()
  })

  it('re-evaluates the deferred list after folding in batch one answers, dropping moot questions', () => {
    const { deferred } = batchQuestions(candidates)
    const mootIds = new Set(['c4', 'c5'])
    const batchTwo = refineDeferredBatch(deferred, (q) => mootIds.has(q.id))
    expect(batchTwo.map((q) => q.id)).toEqual(['c6'])
  })
})
