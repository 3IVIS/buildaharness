import { describe, it, expect } from 'vitest'
import {
  ESCALATION_LAYERS, FLOOR_LAYERS, LAYER_CLASS, OPT_IN_CALL_COST, OPT_IN_DISABLED_TRIGGER, OPT_IN_EVIDENCE, OPT_IN_FLAG, OPT_IN_LAYERS,
  resolveLayerPolicy, staticLayerPolicy, type OptInLayer, type PolicyRules,
} from './layer-policy.js'
import { resolveModedLayerPolicy } from './layer-policy-mode.js'
import { computeRunState, type TurnSignals } from './turn-signals.js'

const sig: TurnSignals = { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(['write_file']) }
const ALL: readonly OptInLayer[] = OPT_IN_LAYERS
const unlimited = { remainingCalls: null }

describe('opt-in layers: the taxonomy', () => {
  it('every opt-in layer is classed opt_in and carries a flag, an evidence grade and a call cost', () => {
    for (const l of OPT_IN_LAYERS) {
      expect(LAYER_CLASS[l]).toBe('opt_in')
      expect(OPT_IN_FLAG[l]).toMatch(/^AUDIT_/)
      expect(OPT_IN_EVIDENCE[l]).toBeDefined()
      expect(OPT_IN_CALL_COST[l]).toBeGreaterThanOrEqual(0)
    }
    expect(Object.values(LAYER_CLASS).filter((c) => c === 'opt_in')).toHaveLength(OPT_IN_LAYERS.length)
  })

  it('no layer is in two classes: opt-in layers are not escalations or floors', () => {
    for (const l of OPT_IN_LAYERS) {
      expect((ESCALATION_LAYERS as readonly string[]).includes(l)).toBe(false)
      expect((FLOOR_LAYERS as readonly string[]).includes(l)).toBe(false)
    }
  })

  it('none is certified as helping — the record does not claim more than was shown', () => {
    for (const l of OPT_IN_LAYERS) expect(['mechanism_verified', 'suggestive', 'untested_with_real_model']).toContain(OPT_IN_EVIDENCE[l])
  })
})

describe('opt-in layers: static baseline is off, not full', () => {
  it('with nothing enabled every opt-in layer is off with the opt_in_disabled trigger, naming its flag', () => {
    const p = staticLayerPolicy()
    for (const l of OPT_IN_LAYERS) {
      expect(p[l]).toMatchObject({ decision: 'off', trigger: OPT_IN_DISABLED_TRIGGER })
      expect(p[l].reason).toContain(OPT_IN_FLAG[l])
    }
  })

  it('enabling one makes only that one full, with the ordinary static trigger', () => {
    const p = staticLayerPolicy(['reviewer_revision'])
    expect(p.reviewer_revision).toMatchObject({ decision: 'full', trigger: 'static' })
    expect(p.source_reliability.decision).toBe('off')
    expect(p.semantic_hypotheses.decision).toBe('off')
    expect(p.experience_learning.decision).toBe('off')
  })

  it('leaves every non-opt-in layer exactly as before', () => {
    const p = staticLayerPolicy()
    for (const l of Object.keys(LAYER_CLASS) as (keyof typeof LAYER_CLASS)[]) {
      if (LAYER_CLASS[l] !== 'opt_in') expect(p[l]).toMatchObject({ decision: 'full', trigger: 'static' })
    }
  })
})

describe('opt-in layers: the resolver', () => {
  it('AL-1: nothing a rule proposes can switch a disabled opt-in layer on', () => {
    const rules: PolicyRules = {}
    for (const l of ESCALATION_LAYERS) rules[l] = () => ({ decision: 'full', trigger: 'rule_full' })
    for (const budget of [null, 0, 1, 5]) {
      const p = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: budget }, rules)
      for (const l of OPT_IN_LAYERS) expect(p[l]).toMatchObject({ decision: 'off', trigger: OPT_IN_DISABLED_TRIGGER })
    }
  })

  it('no rules, unlimited budget: the resolved policy is exactly the static one, with or without opt-ins enabled', () => {
    expect(resolveLayerPolicy(sig, undefined, unlimited)).toEqual(staticLayerPolicy())
    expect(resolveLayerPolicy(sig, undefined, unlimited, {}, ALL)).toEqual(staticLayerPolicy(ALL))
  })

  it('a budget that pays for the escalations but not an enabled opt-in layer turns that layer off and says why', () => {
    const escalationCost = ESCALATION_LAYERS.length
    const p = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: escalationCost }, {}, ['semantic_hypotheses'])
    expect(p.semantic_hypotheses).toMatchObject({ decision: 'off', trigger: 'budget_exhausted' })
    for (const l of ESCALATION_LAYERS) expect(p[l].decision).toBe('full')
  })

  it('a budget with room for it keeps an enabled opt-in layer full', () => {
    const p = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: ESCALATION_LAYERS.length + OPT_IN_CALL_COST.semantic_hypotheses }, {}, ['semantic_hypotheses'])
    expect(p.semantic_hypotheses).toMatchObject({ decision: 'full', trigger: 'static' })
  })

  it('a layer that makes no LLM call is never degraded by an empty budget', () => {
    const p = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: 0 }, {}, ['experience_learning'])
    expect(p.experience_learning).toMatchObject({ decision: 'full', trigger: 'static' })
  })

  it('a disabled layer stays disabled (not budget_exhausted) when the budget is empty', () => {
    const p = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: 0 })
    for (const l of OPT_IN_LAYERS) expect(p[l].trigger).toBe(OPT_IN_DISABLED_TRIGGER)
  })

  it('a throwing rule falls back to static for the same enabled set', () => {
    const p = resolveLayerPolicy(sig, undefined, unlimited, { change_review: () => { throw new Error('boom') } }, ['reviewer_revision'])
    expect(p).toEqual(staticLayerPolicy(['reviewer_revision']))
  })
})

describe('opt-in layers: the moded wrapper carries the enabled set', () => {
  it('static, shadow and adaptive all record the same enabled set', () => {
    for (const mode of ['static', 'shadow', 'adaptive'] as const) {
      const r = resolveModedLayerPolicy(mode, sig, computeRunState(), unlimited, {}, ['source_reliability'])
      expect(r.executed.source_reliability.decision).toBe('full')
      expect(r.executed.reviewer_revision.decision).toBe('off')
      if (mode === 'shadow') expect(r.shadow?.policy.source_reliability.decision).toBe('full')
    }
  })
})
