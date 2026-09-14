import { describe, it, expect } from 'vitest'
import { diagnoseReviewFailureOptions, buildReviewFailureQuestion } from './review-proposed-change.js'
import type { DimensionResult } from './review-proposed-change.js'

// Q7 of plans/ask_question_and_plan_mode_plan.html — deterministic trigger sites.
// review_failure's candidate-fix diagnosis: deterministic, no LLM call.

const dim = (dimension: DimensionResult['dimension'], reason = 'r'): DimensionResult => ({
  dimension,
  passed: false,
  reason,
})

describe('diagnoseReviewFailureOptions', () => {
  it('returns undefined for a single failed dimension — not "more than one plausible fix"', () => {
    expect(diagnoseReviewFailureOptions([dim('task_alignment')])).toBeUndefined()
  })

  it('returns undefined for zero failed dimensions', () => {
    expect(diagnoseReviewFailureOptions([])).toBeUndefined()
  })

  it('returns one option per distinct dimension for two or more failures', () => {
    const options = diagnoseReviewFailureOptions([dim('task_alignment'), dim('code_quality')])
    expect(options).toHaveLength(2)
    expect(options?.map((o) => o.label)).toEqual([
      'Revise the proposed change to align with the current task description',
      'Address the code-quality issue before proceeding',
    ])
  })

  it('dedupes repeated dimensions', () => {
    const options = diagnoseReviewFailureOptions([dim('task_alignment'), dim('task_alignment'), dim('code_quality')])
    expect(options).toHaveLength(2)
  })

  it('falls back to undefined when every dimension fails (exceeds the 4-option cap)', () => {
    const options = diagnoseReviewFailureOptions([
      dim('task_alignment'),
      dim('world_model_consistency'),
      dim('output_contract_precheck'),
      dim('code_quality'),
      dim('hypothesis_compatibility'),
    ])
    expect(options).toBeUndefined()
  })
})

describe('buildReviewFailureQuestion', () => {
  it('wraps diagnosed options into an AskQuestion', () => {
    const options = diagnoseReviewFailureOptions([dim('task_alignment'), dim('code_quality')])!
    const question = buildReviewFailureQuestion(options)
    expect(question.id).toBe('review-failure-resolution')
    expect(question.options).toBe(options)
  })
})
