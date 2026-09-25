import { describe, it, expect } from 'vitest'
import type { PolicyRules, RunState, TurnSignals } from '@buildaharness/harness'
import { resolveEscalationPlan, escalationEnabled, explicitEnvOverride, SEMANTIC_ESCALATIONS, ESCALATION_ENV } from './layer-policy-wiring.js'
import { buildTurnFacts } from './memory-service.js'

const routineSignals: TurnSignals = {
  riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(),
  ambiguity: 'none', pushbackOnPriorTurn: false, statesConstraint: false, isTrivial: false,
} as unknown as TurnSignals
const healthy = { untrustedContentInContext: false, consecutiveFailures: 0, diagnosticsTrend: 'stable', verificationTrend: 'stable' } as unknown as RunState
const riskySignals = { ...routineSignals, riskLevel: 'HIGH' } as TurnSignals

describe('AL8a escalation wiring', () => {
  it('static and shadow keep every escalation ON (today)', () => {
    for (const mode of ['static', 'shadow'] as const) {
      const plan = resolveEscalationPlan(mode, routineSignals, healthy)
      for (const l of SEMANTIC_ESCALATIONS) expect(escalationEnabled(l, plan, {})).toBe(true)
    }
  })

  it('adaptive T1 turn turns every semantic escalation off', () => {
    const plan = resolveEscalationPlan('adaptive', routineSignals, healthy)
    expect(plan.tier).toBe('T1')
    for (const l of SEMANTIC_ESCALATIONS) {
      expect(escalationEnabled(l, plan, {})).toBe(false)
      expect(plan.policy[l].trigger).toBe('tier_t1')
    }
  })

  it('adaptive T2 turn keeps them on', () => {
    const plan = resolveEscalationPlan('adaptive', riskySignals, healthy)
    expect(plan.tier).toBe('T2')
    for (const l of SEMANTIC_ESCALATIONS) expect(escalationEnabled(l, plan, {})).toBe(true)
  })

  it('adaptive rules can turn a layer off and on from a trigger', () => {
    const rules: PolicyRules = {
      change_review: (ctx) => (ctx.signals.statesConstraint ? { decision: 'full', trigger: 'states_constraint' } : { decision: 'off', trigger: 'no_constraint' }),
    }
    const off = resolveEscalationPlan('adaptive', riskySignals, healthy, rules)
    expect(escalationEnabled('change_review', off, {})).toBe(false)
    const on = resolveEscalationPlan('adaptive', { ...riskySignals, statesConstraint: true } as TurnSignals, healthy, rules)
    expect(escalationEnabled('change_review', on, {})).toBe(true)
    expect(on.policy.change_review.trigger).toBe('states_constraint')
  })

  it('an explicit env override wins over the policy in both directions', () => {
    const t1 = resolveEscalationPlan('adaptive', routineSignals, healthy)
    for (const l of SEMANTIC_ESCALATIONS) {
      expect(escalationEnabled(l, t1, { [ESCALATION_ENV[l]]: '1' })).toBe(true)
      expect(escalationEnabled(l, resolveEscalationPlan('static', routineSignals, healthy), { [ESCALATION_ENV[l]]: 'off' })).toBe(false)
    }
    expect(explicitEnvOverride('X', { X: '' })).toBeUndefined()
  })

  it('a throwing rule falls back to today (ON)', () => {
    const plan = resolveEscalationPlan('adaptive', riskySignals, healthy, { failure_match: () => { throw new Error('boom') } })
    for (const l of SEMANTIC_ESCALATIONS) expect(escalationEnabled(l, plan, {})).toBe(true)
  })

  it('a missing plan keeps today (ON)', () => {
    expect(escalationEnabled('semantic_contradiction', undefined, {})).toBe(true)
  })

  it('buildTurnFacts drops model_inferred facts when the policy says off, keeps them by default', () => {
    const stated = [{ text: 'I work at Acme', durable: true, confidence: 'high', category: 'work' }] as never
    expect(buildTurnFacts('s', 'hello there', stated).some(f => f.source === 'model_inferred')).toBe(true)
    expect(buildTurnFacts('s', 'hello there', stated, false).some(f => f.source === 'model_inferred')).toBe(false)
  })
})
