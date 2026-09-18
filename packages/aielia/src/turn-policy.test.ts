import { describe, it, expect } from 'vitest'
import { evaluateTurnPolicy, evaluateAbandonPolicy, type TurnPolicyInput } from './turn-policy.js'

describe('evaluateTurnPolicy', () => {
  it('requires approval on HIGH risk', () => {
    expect(evaluateTurnPolicy({ riskHint: 'HIGH', isBulkReminderRequest: false }).decision).toBe('REQUIRE_APPROVAL')
  })

  it('requires approval on the fail-safe UNKNOWN riskHint', () => {
    expect(evaluateTurnPolicy({ riskHint: 'UNKNOWN', isBulkReminderRequest: false }).decision).toBe('REQUIRE_APPROVAL')
  })

  it('requires approval on a bulk reminder request even at MEDIUM risk', () => {
    expect(evaluateTurnPolicy({ riskHint: 'MEDIUM', isBulkReminderRequest: true }).decision).toBe('REQUIRE_APPROVAL')
  })

  it('allows ordinary MEDIUM risk with no bulk reminder', () => {
    expect(evaluateTurnPolicy({ riskHint: 'MEDIUM', isBulkReminderRequest: false }).decision).toBe('ALLOW')
  })

  it('allows LOW risk', () => {
    expect(evaluateTurnPolicy({ riskHint: 'LOW', isBulkReminderRequest: false }).decision).toBe('ALLOW')
  })

  it('is pure — same input always yields the same decision (no hidden state, no I/O)', () => {
    const input: TurnPolicyInput = { riskHint: 'HIGH', isBulkReminderRequest: false }
    const first = evaluateTurnPolicy(input)
    const second = evaluateTurnPolicy(input)
    expect(second).toEqual(first)
  })

  // INV-14 (Phase D — a consequential decision cannot be set by LLM output alone): TurnPolicyInput
  // has no `requiresApproval` field to read at all — the only way to reach REQUIRE_APPROVAL is
  // through the riskHint/isBulkReminderRequest signals this function itself interprets. A caller
  // cannot short-circuit the decision by handing it a classifier-produced boolean directly, even
  // an inconsistent one (e.g. a hypothetical classifier bug that mislabels a HIGH-risk turn's own
  // requiresApproval as false still can't suppress this gate, because that field is never an input
  // here in the first place).
  it('INV-14: the decision is derived solely from riskHint/isBulkReminderRequest, never a passed-through approval boolean', () => {
    const highRisk: TurnPolicyInput = { riskHint: 'HIGH', isBulkReminderRequest: false }
    expect(Object.keys(highRisk)).not.toContain('requiresApproval')
    expect(evaluateTurnPolicy(highRisk).decision).toBe('REQUIRE_APPROVAL')
  })
})

describe('evaluateAbandonPolicy', () => {
  it('never abandons when no plan is active, regardless of the LLM hint', () => {
    expect(evaluateAbandonPolicy({ hasActivePlan: false, abandonHint: true })).toBe(false)
  })

  it('does not abandon an active plan absent the LLM hint', () => {
    expect(evaluateAbandonPolicy({ hasActivePlan: true, abandonHint: false })).toBe(false)
  })

  it('abandons only when both a plan is active and the hint is set', () => {
    expect(evaluateAbandonPolicy({ hasActivePlan: true, abandonHint: true })).toBe(true)
  })
})
