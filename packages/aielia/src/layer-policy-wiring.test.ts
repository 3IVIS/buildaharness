import { describe, it, expect, vi } from 'vitest'
import { OPT_IN_LAYERS, type PolicyRules, type RunState, type TurnSignals } from '@buildaharness/harness'
import { resolveEscalationPlan, resolveOptInPlan, optInLayerEnabled, enabledOptInLayers, turnPolicyBudget, escalationEnabled, explicitEnvOverride, SEMANTIC_ESCALATIONS, ESCALATION_ENV } from './layer-policy-wiring.js'
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

import { harnessGatePolicy, decompositionReframeEnabled, injectionDetectionEnabled, decisionNote } from './layer-policy-wiring.js'
import { buildWhyChain } from './node-display-names.js'

describe('AL8b decomposition reframe + injection + rendering', () => {
  const ruleOff: PolicyRules = { decomposition_reframe: () => ({ decision: 'off', trigger: 'single_step' }) }
  const ruleOn: PolicyRules = { decomposition_reframe: (ctx) => ctx.signals.riskLevel === 'HIGH' ? { decision: 'full', trigger: 'high_risk' } : { decision: 'off', trigger: 'routine' } }

  it('reframe: static/shadow ON; adaptive can turn it off and on from a trigger', () => {
    expect(decompositionReframeEnabled(resolveEscalationPlan('static', routineSignals, healthy), {})).toBe(true)
    expect(decompositionReframeEnabled(resolveEscalationPlan('shadow', routineSignals, healthy, ruleOff), {})).toBe(true)
    // T2 (risky) turn so the tier override does not apply; rule decides.
    expect(decompositionReframeEnabled(resolveEscalationPlan('adaptive', riskySignals, healthy, ruleOff), {})).toBe(false)
    expect(decompositionReframeEnabled(resolveEscalationPlan('adaptive', riskySignals, healthy, ruleOn), {})).toBe(true)
    expect(decompositionReframeEnabled(resolveEscalationPlan('adaptive', routineSignals, healthy, ruleOn), {})).toBe(false)
  })

  it('reframe: explicit AUDIT_DECOMPOSITION wins both ways; missing plan ⇒ ON', () => {
    const off = resolveEscalationPlan('adaptive', riskySignals, healthy, ruleOff)
    const on = resolveEscalationPlan('adaptive', riskySignals, healthy, ruleOn)
    expect(decompositionReframeEnabled(off, { AUDIT_DECOMPOSITION: '1' })).toBe(true)
    expect(decompositionReframeEnabled(on, { AUDIT_DECOMPOSITION: '0' })).toBe(false)
    expect(decompositionReframeEnabled(undefined, {})).toBe(true)
  })

  it('reframe: a throwing rule falls back to static ON', () => {
    const boom: PolicyRules = { decomposition_reframe: () => { throw new Error('x') } }
    expect(decompositionReframeEnabled(resolveEscalationPlan('adaptive', riskySignals, healthy, boom), {})).toBe(true)
  })

  it('injection detection cannot be skipped when untrusted content is in context and a tool-capable step exists', () => {
    const skip: PolicyRules = { injection_detection: () => ({ decision: 'off', trigger: 'try_skip' }) }
    const untrusted = { ...healthy, untrustedContentInContext: true } as RunState
    const withTools = { ...riskySignals, consequentialTools: new Set(['write_file']) } as TurnSignals
    const plan = resolveEscalationPlan('adaptive', withTools, untrusted, skip)
    expect(plan.policy.injection_detection.decision).toBe('full')
    expect(injectionDetectionEnabled(plan, { untrustedContentInContext: true, toolCapableNextStep: true })).toBe(true)
    // A hand-built plan that tries to skip is re-clamped by the wiring itself.
    const forged = { ...plan, policy: { ...plan.policy, injection_detection: { decision: 'off', trigger: 'forged', reason: '' } } } as typeof plan
    expect(injectionDetectionEnabled(forged, { untrustedContentInContext: true, toolCapableNextStep: true })).toBe(true)
  })

  it('injection detection may be skipped only on a non-linguistic proof', () => {
    const forged = { mode: 'adaptive', tier: 'T2', policy: { injection_detection: { decision: 'off', trigger: 't', reason: '' } } } as unknown as ReturnType<typeof resolveEscalationPlan>
    expect(injectionDetectionEnabled(forged, { untrustedContentInContext: false, toolCapableNextStep: true })).toBe(false)
    expect(injectionDetectionEnabled(forged, { untrustedContentInContext: true, toolCapableNextStep: false })).toBe(false)
    expect(injectionDetectionEnabled(undefined, { untrustedContentInContext: false, toolCapableNextStep: false })).toBe(true)
  })

  it('harnessGatePolicy only exposes an adaptive policy', () => {
    expect(harnessGatePolicy(resolveEscalationPlan('static', routineSignals, healthy))).toBeUndefined()
    expect(harnessGatePolicy(resolveEscalationPlan('shadow', routineSignals, healthy))).toBeUndefined()
    expect(harnessGatePolicy(resolveEscalationPlan('adaptive', routineSignals, healthy))).toBeDefined()
    expect(harnessGatePolicy(undefined)).toBeUndefined()
  })

  it('rendering: quiet when routine; shows decision+trigger when escalated or skipped-with-reason', () => {
    expect(decisionNote({ decision: 'full', trigger: 'static' })).toBeUndefined()
    expect(decisionNote({ decision: 'off', trigger: 'tier_t1' })).toBe('off: tier_t1')
    const chain = buildWhyChain([
      { layer: 'hypothesis', fired: false, reason: 'quiet' },
      { layer: 'world_model', fired: false, reason: 'belief trail skipped by layer policy', decision: 'off', trigger: 'low_risk' },
      { layer: 'contradiction', fired: true, reason: 'conflict', decision: 'full', trigger: 'belief_conflict' },
      { layer: 'verification', fired: true, reason: 'ok', decision: 'full', trigger: 'static' },
    ])
    expect(chain).toEqual([
      { layer: 'world_model', reason: 'belief trail skipped by layer policy [off: low_risk]' },
      { layer: 'contradiction', reason: 'conflict [full: belief_conflict]' },
      { layer: 'verification', reason: 'ok' },
    ])
  })
})

describe('AL9a: per-turn call budget through resolveEscalationPlan', () => {
  const signals = { riskLevel: 'LOW' as const, taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(['write_file']) }
  const state = { consecutiveFailures: 0, turnDepth: 0, cumulativeSpend: 0, sessionBudget: null, diagnosticsTrend: 'unknown' as const, verificationTrend: 'unknown' as const, toolReliability: {}, untrustedContentInContext: true }

  it('static mode ignores the budget (byte-identical policy)', () => {
    const withBudget = resolveEscalationPlan('static', signals, state, {}, turnPolicyBudget(signals))
    const without = resolveEscalationPlan('static', signals, state)
    expect(withBudget.policy).toEqual(without.policy)
  })

  it('adaptive mode degrades the lowest-priority escalations on a LOW-risk turn, with a budget_exhausted trigger', () => {
    const plan = resolveEscalationPlan('adaptive', signals, state, {}, turnPolicyBudget(signals))
    expect(plan.policy.decomposition_reframe.trigger).toBe('budget_exhausted')
    expect(plan.policy.injection_detection.decision).toBe('full')
  })

  it('shadow records the degraded policy without executing it', () => {
    const plan = resolveEscalationPlan('shadow', signals, state, {}, turnPolicyBudget(signals))
    expect(plan.policy.decomposition_reframe.trigger).toBe('static')
    expect(plan.shadow?.policy.decomposition_reframe.trigger).toBe('budget_exhausted')
  })
})

describe('enabledOptInLayers / the opt-in category in the recorded plan', () => {
  const FLAGS = ['AUDIT_SEMANTIC_SOURCE_RELIABILITY', 'AUDIT_SEMANTIC_HYPOTHESES', 'AUDIT_REVIEWER_REVISION', 'AUDIT_EXPERIENCE_LEARNING', 'AUDIT_SEMANTIC_COMPACTION']
  it('nothing is enabled by default, and each flag enables exactly its own layer', () => {
    expect(enabledOptInLayers({})).toEqual([])
    const byFlag: Record<string, string> = {
      AUDIT_SEMANTIC_SOURCE_RELIABILITY: 'source_reliability',
      AUDIT_SEMANTIC_HYPOTHESES: 'semantic_hypotheses',
      AUDIT_REVIEWER_REVISION: 'reviewer_revision',
      AUDIT_EXPERIENCE_LEARNING: 'experience_learning',
      AUDIT_SEMANTIC_COMPACTION: 'semantic_compaction',
    }
    for (const f of FLAGS) expect(enabledOptInLayers({ [f]: '1' })).toEqual([byFlag[f]])
  })

  it('the plan the assistant records shows an enabled opt-in layer as full and the rest as off', () => {
    const prior = process.env.AUDIT_REVIEWER_REVISION
    process.env.AUDIT_REVIEWER_REVISION = '1'
    try {
      const plan = resolveEscalationPlan('static', { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set() }, undefined)
      expect(plan.policy.reviewer_revision.decision).toBe('full')
      expect(plan.policy.source_reliability).toMatchObject({ decision: 'off', trigger: 'opt_in_disabled' })
    } finally {
      if (prior === undefined) delete process.env.AUDIT_REVIEWER_REVISION
      else process.env.AUDIT_REVIEWER_REVISION = prior
    }
  })
})

describe('opt-in layers obey the layer policy', () => {
  const classification = {
    riskLevel: 'LOW', needsGrounding: false, ambiguity: 'none', userPosture: 'informational',
    pushbackOnPriorTurn: false, statesConstraint: false, isTrivial: false,
  } as unknown as Parameters<typeof resolveOptInPlan>[1]
  const allOn = ['AUDIT_SEMANTIC_SOURCE_RELIABILITY', 'AUDIT_SEMANTIC_HYPOTHESES', 'AUDIT_REVIEWER_REVISION', 'AUDIT_EXPERIENCE_LEARNING', 'AUDIT_SEMANTIC_COMPACTION']

  const withAllOn = (fn: () => void) => {
    for (const v of allOn) vi.stubEnv(v, '1')
    try { fn() } finally { vi.unstubAllEnvs() }
  }

  it('static and shadow resolve no plan, so every enabled layer runs (today)', () => {
    withAllOn(() => {
      for (const mode of ['static', 'shadow'] as const) {
        const plan = resolveOptInPlan(mode, classification)
        expect(plan).toBeUndefined()
        for (const l of OPT_IN_LAYERS) expect(optInLayerEnabled(l, true, plan)).toBe(true)
      }
    })
  })

  it('a disabled layer is never switched on by the plan', () => {
    withAllOn(() => {
      const plan = resolveOptInPlan('adaptive', classification)
      for (const l of OPT_IN_LAYERS) expect(optInLayerEnabled(l, false, plan)).toBe(false)
    })
  })

  it('adaptive: a layer the plan switched off for budget does not run, and the rest still do', () => {
    withAllOn(() => {
      const plan = resolveOptInPlan('adaptive', classification)!
      const off = OPT_IN_LAYERS.filter((l) => plan.policy[l].decision === 'off')
      // A LOW-risk turn has 3 calls; the five escalations draw first, so the opt-in layers run out.
      expect(off.length).toBeGreaterThan(0)
      expect(off.length).toBeLessThan(OPT_IN_LAYERS.length)
      for (const l of OPT_IN_LAYERS) {
        expect(plan.policy[l].decision === 'off').toBe(off.includes(l))
        expect(optInLayerEnabled(l, true, plan)).toBe(!off.includes(l))
      }
      for (const l of off) expect(plan.policy[l].trigger).toBe('budget_exhausted')
    })
  })
})
