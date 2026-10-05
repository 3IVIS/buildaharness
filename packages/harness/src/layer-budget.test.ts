import { describe, it, expect } from 'vitest'
import {
  resolveLayerPolicy, staticLayerPolicy, ESCALATION_LAYERS, FLOOR_LAYERS, DEFAULT_LAYER_PRIORITY, LAYER_CALL_COST,
  type PolicyRules,
} from './layer-policy.js'
import { computeTurnCallBudget, toPolicyBudget } from './layer-budget.js'
import { Budget } from './state/budget.js'
import type { TurnSignals, RunState } from './turn-signals.js'

const sig = (): TurnSignals => ({ riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(['write_file']) })
const st = (untrusted = true): RunState => ({
  consecutiveFailures: 0, turnDepth: 0, cumulativeSpend: 0, sessionBudget: null,
  diagnosticsTrend: 'unknown', verificationTrend: 'unknown', toolReliability: {}, untrustedContentInContext: untrusted,
})
const fullCount = (p: ReturnType<typeof staticLayerPolicy>) => ESCALATION_LAYERS.filter(l => p[l].decision === 'full').length

describe('AL9a per-turn LLM-call budget', () => {
  it('scales by risk and posture, unknown risk is treated as HIGH', () => {
    expect(computeTurnCallBudget({ riskLevel: 'LOW' }).maxCalls).toBe(3)
    expect(computeTurnCallBudget({ riskLevel: 'MEDIUM' }).maxCalls).toBe(5)
    expect(computeTurnCallBudget({ riskLevel: 'HIGH' }).maxCalls).toBe(8)
    expect(computeTurnCallBudget({ riskLevel: 'bogus' }).maxCalls).toBe(8)
    expect(computeTurnCallBudget({}).maxCalls).toBe(8)
    expect(computeTurnCallBudget({ riskLevel: 'LOW', userPosture: 'corrective' }).maxCalls).toBe(5)
  })

  it('never spends more than the budget, for any size', () => {
    for (let n = 0; n <= 9; n++) {
      const p = resolveLayerPolicy(sig(), st(), { remainingCalls: n })
      const spent = ESCALATION_LAYERS.filter(l => p[l].decision === 'full').reduce((a, l) => a + LAYER_CALL_COST[l], 0)
      // the injection security clamp is the only sanctioned overdraw (no proof of safety here ⇒ it stays full)
      expect(spent).toBeLessThanOrEqual(Math.max(n, LAYER_CALL_COST.injection_detection))
    }
  })

  it('floor layers are never degraded, even at zero budget', () => {
    const p = resolveLayerPolicy(sig(), st(), { remainingCalls: 0 })
    for (const l of FLOOR_LAYERS) expect(p[l]).toEqual(staticLayerPolicy()[l])
  })

  it('spends in deterministic priority order; the tail degrades with trigger budget_exhausted', () => {
    const p = resolveLayerPolicy(sig(), st(), { remainingCalls: 3 })
    const funded = DEFAULT_LAYER_PRIORITY.slice(0, 3)
    for (const l of funded) expect(p[l].decision).toBe('full')
    for (const l of DEFAULT_LAYER_PRIORITY.slice(3)) {
      expect(p[l].trigger).toBe('budget_exhausted')
      expect(p[l].decision).not.toBe('full')
    }
    expect(resolveLayerPolicy(sig(), st(), { remainingCalls: 3 })).toEqual(p)
  })

  it('a custom priority is honoured ahead of the default order', () => {
    const p = resolveLayerPolicy(sig(), st(), { remainingCalls: 1, priority: ['decomposition_reframe'] })
    expect(p.decomposition_reframe.decision).toBe('full')
    expect(p.semantic_contradiction.trigger).toBe('budget_exhausted')
  })

  it('layers a rule turned off do not draw on the budget', () => {
    const rules: PolicyRules = { semantic_contradiction: () => ({ decision: 'off', trigger: 'calm' }) }
    const p = resolveLayerPolicy(sig(), st(), { remainingCalls: 2 }, rules)
    expect(p.semantic_contradiction.trigger).toBe('calm')
    expect(fullCount(p)).toBe(2)
  })

  it('exhaustion degrades non-cheap layers to off and criterion_coverage to cheap', () => {
    const p = resolveLayerPolicy(sig(), st(), { remainingCalls: 0 })
    expect(p.criterion_coverage).toMatchObject({ decision: 'cheap', trigger: 'budget_exhausted' })
    expect(p.change_review).toMatchObject({ decision: 'off', trigger: 'budget_exhausted' })
  })

  it('injection detection is never degraded without proof of safety, even at zero budget', () => {
    const p = resolveLayerPolicy(sig(), st(), { remainingCalls: 0 }, {})
    expect(p.injection_detection).toMatchObject({ decision: 'full', trigger: 'security_floor' })
    const safe = resolveLayerPolicy(sig(), st(false), { remainingCalls: 0 })
    expect(safe.injection_detection).toMatchObject({ decision: 'off', trigger: 'budget_exhausted' })
  })

  it('an unlimited budget (null / Infinity) is byte-identical to static', () => {
    expect(resolveLayerPolicy(sig(), st(), { remainingCalls: null })).toEqual(staticLayerPolicy())
    expect(resolveLayerPolicy(sig(), st(), toPolicyBudget(new Budget()))).toEqual(staticLayerPolicy())
  })

  it('toPolicyBudget reflects consumed calls', () => {
    expect(toPolicyBudget(new Budget({ maxCalls: 4 }).consume({ calls: 3 })).remainingCalls).toBe(1)
  })
})
