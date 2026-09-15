import { describe, it, expect } from 'vitest'
import { shouldRenderAskQuestionCard } from './ask-question-render'

const QUESTION = { id: 'q1', question: 'Which language?', options: [{ label: 'TypeScript' }, { label: 'Python' }] }

describe('shouldRenderAskQuestionCard', () => {
  it('renders the card for a populated needs_clarification result', () => {
    expect(
      shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: 'p1', questions: [QUESTION] }),
    ).toBe(true)
  })

  it('falls back to the plain escalation path when status is not needs_clarification', () => {
    expect(
      shouldRenderAskQuestionCard({ status: 'escalated', pendingClarificationId: 'p1', questions: [QUESTION] }),
    ).toBe(false)
  })

  it('falls back when questions is absent (today\'s plain escalation shape)', () => {
    expect(shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: 'p1', questions: undefined })).toBe(false)
  })

  it('falls back when questions is an empty array', () => {
    expect(shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: 'p1', questions: [] })).toBe(false)
  })

  it('falls back when pendingClarificationId is missing — nothing to resume against', () => {
    expect(
      shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: undefined, questions: [QUESTION] }),
    ).toBe(false)
  })
})
