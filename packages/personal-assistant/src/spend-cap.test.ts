import { describe, it, expect } from 'vitest'
import { checkSpendCap, formatSpendCapStatus, type SpendState } from './spend-cap.js'

const state = (cumulativeCostUsd: number, cumulativeCalls: number): SpendState => ({ cumulativeCostUsd, cumulativeCalls })

describe('checkSpendCap', () => {
  it('allows a turn when no ceiling is configured', () => {
    expect(checkSpendCap(state(1000, 1000), {})).toEqual({ allowed: true })
  })

  it('allows a turn under the configured cost ceiling', () => {
    expect(checkSpendCap(state(1, 3), { sessionCostLimitUsd: 5 })).toEqual({ allowed: true })
  })

  it('refuses a turn once cumulative cost reaches the ceiling', () => {
    const result = checkSpendCap(state(5, 3), { sessionCostLimitUsd: 5 })
    expect(result.allowed).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/cost ceiling reached/)
    expect((result as { reason: string }).reason).toMatch(/sessionCostLimitUsd/)
  })

  it('refuses a turn once cumulative cost exceeds the ceiling', () => {
    expect(checkSpendCap(state(5.01, 3), { sessionCostLimitUsd: 5 }).allowed).toBe(false)
  })

  it('allows a turn under the configured call ceiling', () => {
    expect(checkSpendCap(state(0, 4), { sessionCallLimit: 5 })).toEqual({ allowed: true })
  })

  it('refuses a turn once cumulative turn count reaches the call ceiling', () => {
    const result = checkSpendCap(state(0, 5), { sessionCallLimit: 5 })
    expect(result.allowed).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/turn-count ceiling reached/)
    expect((result as { reason: string }).reason).toMatch(/sessionCallLimit/)
  })

  it('checks cost before call count — a cost-ceiling breach is reported even if the call ceiling would also be hit', () => {
    const result = checkSpendCap(state(10, 10), { sessionCostLimitUsd: 5, sessionCallLimit: 5 })
    expect((result as { reason: string }).reason).toMatch(/cost ceiling/)
  })

  it('both ceilings configured, only cost breached: refuses with the cost reason', () => {
    const result = checkSpendCap(state(10, 1), { sessionCostLimitUsd: 5, sessionCallLimit: 100 })
    expect((result as { reason: string }).reason).toMatch(/cost ceiling/)
  })
})

describe('formatSpendCapStatus', () => {
  it('returns undefined when no ceiling is configured', () => {
    expect(formatSpendCapStatus(state(1, 1), {})).toBeUndefined()
  })

  it('shows a dollar-and-percent line when a cost ceiling is configured', () => {
    const line = formatSpendCapStatus(state(2.5, 3), { sessionCostLimitUsd: 5 })
    expect(line).toContain('$2.5000 / $5.00')
    expect(line).toContain('50%')
  })

  it('caps the displayed percentage at 100% even when over the ceiling', () => {
    const line = formatSpendCapStatus(state(9, 3), { sessionCostLimitUsd: 5 })
    expect(line).toContain('100%')
  })

  it('shows a turn-count line when a call ceiling is configured', () => {
    const line = formatSpendCapStatus(state(0, 4), { sessionCallLimit: 10 })
    expect(line).toBe('4/10 turns')
  })

  it('shows both lines, comma-joined, when both ceilings are configured', () => {
    const line = formatSpendCapStatus(state(1, 2), { sessionCostLimitUsd: 5, sessionCallLimit: 10 })
    expect(line).toBe('$1.0000 / $5.00 (20% of ceiling), 2/10 turns')
  })
})
