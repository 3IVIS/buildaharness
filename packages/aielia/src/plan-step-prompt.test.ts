import { describe, it, expect } from 'vitest'
import { buildStepInstruction, planStepPromptEnabled } from './plan-step-prompt.js'

describe('planStepPromptEnabled', () => {
  it('is ON by default and for truthy values; OFF for falsy values', () => {
    expect(planStepPromptEnabled({})).toBe(true)
    expect(planStepPromptEnabled({ AUDIT_PLAN_STEP_PROMPT: '1' })).toBe(true)
    for (const v of ['0', 'false', 'OFF', 'no', 'disabled']) expect(planStepPromptEnabled({ AUDIT_PLAN_STEP_PROMPT: v })).toBe(false)
  })
})

describe('buildStepInstruction', () => {
  it('names the step, asks for its result, and lets the model say what is missing', () => {
    const text = buildStepInstruction('Define launch scope (the previous attempt was not accepted: it only asked questions)')
    expect(text).toContain('"Define launch scope (the previous attempt was not accepted: it only asked questions)"')
    expect(text).toContain('ONE step')
    expect(text).toContain('produce its actual result')
    expect(text).toContain('say exactly what is missing')
  })
})
