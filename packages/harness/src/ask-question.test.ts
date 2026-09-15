import { describe, it, expect } from 'vitest'
import { resolveAskMode, buildAskBlocker, askQuestion, buildBudgetExhaustedQuestion } from './ask-question.js'
import { EscalationHalt, type AskQuestion } from './nodes/escalate.js'

const q = (question = 'which environment?', options: string[] = ['staging', 'production']): AskQuestion[] => [
  { id: 'q1', question, options: options.length ? options.map((label) => ({ label })) : undefined },
]

describe('resolveAskMode — INV-29 (most restrictive of three wins)', () => {
  it.each([
    [false, undefined, true, false],
    [false, true, true, false], // narrower ON can't override global OFF
    [false, false, true, false],
    [true, undefined, true, true],
    [true, true, true, true],
    [true, false, true, false], // session forces off
    [true, undefined, false, false], // call-site forces off
    [true, true, false, false],
    [false, false, false, false],
  ])('globalEnabled=%s sessionAskMode=%s structured=%s -> %s', (globalEnabled, sessionAskMode, structured, expected) => {
    expect(resolveAskMode({ globalEnabled, sessionAskMode, structured })).toBe(expected)
  })
})

describe('buildAskBlocker', () => {
  it('collapses to the legacy question/options shape when disabled', () => {
    const blocker = buildAskBlocker(q(), {
      reason: 'supervisor_question',
      missingInfo: ['m'],
      currentTaskSummary: 't',
      globalEnabled: false,
    })
    expect(blocker.question).toBe('which environment?')
    expect(blocker.options).toEqual(['staging', 'production'])
    expect(blocker.questions).toBeUndefined()
  })

  it('populates the questions batch when enabled', () => {
    const blocker = buildAskBlocker(q(), {
      reason: 'supervisor_question',
      missingInfo: ['m'],
      currentTaskSummary: 't',
      globalEnabled: true,
    })
    expect(blocker.questions).toHaveLength(1)
    expect(blocker.question).toBeUndefined()
    expect(blocker.options).toBeUndefined()
  })

  it('call-site opt-out wins over a global ON', () => {
    const blocker = buildAskBlocker(q(), {
      reason: 'supervisor_question',
      missingInfo: ['m'],
      currentTaskSummary: 't',
      globalEnabled: true,
      structured: false,
    })
    expect(blocker.questions).toBeUndefined()
    expect(blocker.question).toBe('which environment?')
  })

  it('an empty questions array degrades to a plain missing_info-only halt', () => {
    const blocker = buildAskBlocker([], {
      reason: 'cannot_make_progress',
      missingInfo: ['clarification'],
      currentTaskSummary: 't',
      globalEnabled: true,
    })
    expect(blocker.questions).toBeUndefined()
    expect(blocker.question).toBeUndefined()
    expect(blocker.missing_info).toEqual(['clarification'])
  })

  it('omits options when the collapsed question has none', () => {
    const blocker = buildAskBlocker(q('deploy target?', []), {
      reason: 'supervisor_question',
      missingInfo: ['m'],
      currentTaskSummary: 't',
      globalEnabled: false,
    })
    expect(blocker.options).toBeUndefined()
  })
})

describe('askQuestion — caller-agnostic', () => {
  it('a synthetic non-supervisor caller reaches EscalationHalt with the flag on', () => {
    expect(() =>
      askQuestion(q('deploy target?', ['us-east', 'eu-west']), {
        reason: 'blocked_state',
        missingInfo: ['deploy target'],
        currentTaskSummary: 'synthetic test site',
        globalEnabled: true,
      }),
    ).toThrow(EscalationHalt)
  })

  it('degrades to the legacy shape with the flag off', () => {
    try {
      askQuestion(q('deploy target?', ['us-east', 'eu-west']), {
        reason: 'blocked_state',
        missingInfo: ['deploy target'],
        currentTaskSummary: 'synthetic test site',
        globalEnabled: false,
      })
      throw new Error('expected askQuestion to throw')
    } catch (e) {
      if (!(e instanceof EscalationHalt)) throw e
      expect(e.blocker.questions).toBeUndefined()
      expect(e.blocker.question).toBe('deploy target?')
    }
  })
})

// Q7 of plans/ask_question_and_plan_mode_plan.html — deterministic trigger sites.
describe('buildBudgetExhaustedQuestion (Q7)', () => {
  it('returns static, templated options — no LLM call', () => {
    const question = buildBudgetExhaustedQuestion(42)
    expect(question.id).toBe('budget-exhausted-resolution')
    expect(question.options?.map((o) => o.label)).toEqual([
      'Continue with 10 more steps',
      'Stop and summarize progress so far',
      'Let me clarify the goal',
    ])
  })

  it('honors a custom extension count', () => {
    const question = buildBudgetExhaustedQuestion(10, 5)
    expect(question.options?.[0].label).toBe('Continue with 5 more steps')
  })
})
