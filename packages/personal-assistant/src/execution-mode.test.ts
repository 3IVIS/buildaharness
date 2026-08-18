import { describe, it, expect } from 'vitest'
import { classifyExecutionMode } from './execution-mode.js'

const base = { isPlanCancelBypass: false, isBatchResearch: false, isTrivial: false, requiresApproval: false }

describe('classifyExecutionMode', () => {
  it('classifies the plan-cancel bypass as PLAN, regardless of any other field', () => {
    expect(classifyExecutionMode({ ...base, isPlanCancelBypass: true, isTrivial: true, requiresApproval: true })).toBe('PLAN')
  })

  it('classifies a batch-research turn as RESEARCH', () => {
    expect(classifyExecutionMode({ ...base, isBatchResearch: true })).toBe('RESEARCH')
  })

  it('batch-research takes precedence over isTrivial/requiresApproval', () => {
    expect(classifyExecutionMode({ ...base, isBatchResearch: true, isTrivial: true, requiresApproval: true })).toBe('RESEARCH')
  })

  it('classifies requiresApproval as CONSEQUENTIAL', () => {
    expect(classifyExecutionMode({ ...base, requiresApproval: true })).toBe('CONSEQUENTIAL')
  })

  it('requiresApproval takes precedence over isTrivial', () => {
    expect(classifyExecutionMode({ ...base, requiresApproval: true, isTrivial: true })).toBe('CONSEQUENTIAL')
  })

  it('classifies a trivial turn as FAST', () => {
    expect(classifyExecutionMode({ ...base, isTrivial: true })).toBe('FAST')
  })

  it('falls back to TOOL when nothing else applies', () => {
    expect(classifyExecutionMode(base)).toBe('TOOL')
  })
})
