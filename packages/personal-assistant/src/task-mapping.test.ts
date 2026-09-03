import { describe, it, expect } from 'vitest'
import { toHarnessTasks, toTaskRiskLevel, planTaskRiskLevel } from './task-mapping.js'

/**
 * F8 (adoption plan): the threat model claims a classifier failure fails *safe*. The
 * failSafeClassification → 'UNKNOWN' half is pinned in turn-intent-classifier.test.ts; this
 * pins the other half — that every crossing into packages/harness's strict LOW/MEDIUM/HIGH
 * enum maps 'UNKNOWN' to the most cautious level, never the least.
 */
describe('toTaskRiskLevel', () => {
  it("maps 'UNKNOWN' (a classifier failure) to 'HIGH', not 'LOW'", () => {
    expect(toTaskRiskLevel('UNKNOWN')).toBe('HIGH')
  })

  it('passes a real classification level through unchanged', () => {
    expect(toTaskRiskLevel('LOW')).toBe('LOW')
    expect(toTaskRiskLevel('MEDIUM')).toBe('MEDIUM')
    expect(toTaskRiskLevel('HIGH')).toBe('HIGH')
  })
})

describe('toHarnessTasks', () => {
  it("carries the fallback risk level through when a task has no riskLevel of its own — and 'UNKNOWN' is mapped by the caller before it gets here", () => {
    const [task] = toHarnessTasks([{ id: 'respond', description: 'do a thing', depends_on: [] }], toTaskRiskLevel('UNKNOWN'))
    expect(task.risk_level).toBe('HIGH')
    expect(task.status).toBe('PENDING')
  })

  it("prefers a task's own riskLevel over the fallback", () => {
    const [task] = toHarnessTasks([{ id: 'a', description: 'x', depends_on: [], riskLevel: 'LOW' }], 'HIGH')
    expect(task.risk_level).toBe('LOW')
  })
})

describe('planTaskRiskLevel', () => {
  it('classifies a destructive step description as elevated risk', () => {
    expect(planTaskRiskLevel('delete the draft file')).not.toBe('LOW')
  })
})
