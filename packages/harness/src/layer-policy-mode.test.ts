import { describe, it, expect } from 'vitest'
import { resolveModedLayerPolicy, resolveTurnTier, DEFAULT_LAYER_POLICY_MODE } from './layer-policy-mode.js'
import { ESCALATION_LAYERS, staticLayerPolicy, type PolicyRules } from './layer-policy.js'
import { computeRunState, type TurnSignals } from './turn-signals.js'

const RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const
const routine = (over: Partial<TurnSignals> = {}): TurnSignals => ({
  riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(),
  isTrivial: false, ambiguity: 'none', pushbackOnPriorTurn: false, statesConstraint: false, ...over,
})
const offRules: PolicyRules = Object.fromEntries(ESCALATION_LAYERS.map((l) => [l, () => ({ decision: 'off' as const, trigger: 'test_off' })]))

describe('resolveTurnTier', () => {
  it('defaults to static', () => expect(DEFAULT_LAYER_POLICY_MODE).toBe('static'))

  it('static/shadow reproduce today\'s split exactly: isTrivial ⇒ T0, everything else ⇒ T2, never T1', () => {
    for (const mode of ['static', 'shadow'] as const)
      for (const riskLevel of RISKS)
        for (const isTrivial of [true, false, undefined])
          for (const tools of [[], ['write_file']]) {
            const s = routine({ riskLevel, isTrivial, consequentialTools: new Set(tools) })
            expect(resolveTurnTier(s, computeRunState(), mode)).toBe(isTrivial ? 'T0' : 'T2')
          }
  })

  it('an omitted mode is static', () => {
    expect(resolveTurnTier(routine(), computeRunState())).toBe('T2')
  })

  it('adaptive: a routine turn is T1; trivial stays T0', () => {
    expect(resolveTurnTier(routine(), computeRunState(), 'adaptive')).toBe('T1')
    expect(resolveTurnTier(routine({ isTrivial: true }), computeRunState(), 'adaptive')).toBe('T0')
  })

  it('adaptive: any risk/uncertainty signal, or missing state, keeps T2', () => {
    const st = computeRunState()
    const cases: Array<[string, TurnSignals, ReturnType<typeof computeRunState> | undefined]> = [
      ['medium risk', routine({ riskLevel: 'MEDIUM' }), st],
      ['consequential tool', routine({ consequentialTools: new Set(['write_file']) }), st],
      ['multi-step', routine({ taskCount: 3 }), st],
      ['durable plan', routine({ hasDurablePlan: true }), st],
      ['pushback', routine({ pushbackOnPriorTurn: true }), st],
      ['constraint', routine({ statesConstraint: true }), st],
      ['ambiguity some', routine({ ambiguity: 'some' }), st],
      ['ambiguity unknown', routine({ ambiguity: 'unknown' }), st],
      ['ambiguity absent', routine({ ambiguity: undefined }), st],
      ['no state', routine(), undefined],
      ['untrusted content', routine(), computeRunState({ untrustedContentInContext: true })],
      ['failures', routine(), computeRunState({ outcomes: [true] })],
      ['degrading diagnostics', routine(), computeRunState({ diagnosticsScores: [0.9, 0.5, 0.1] })],
    ]
    for (const [name, s, state] of cases) expect(resolveTurnTier(s, state, 'adaptive'), name).toBe('T2')
  })
})

describe('resolveModedLayerPolicy', () => {
  const st = computeRunState()
  it('static executes the static policy and records no shadow', () => {
    const r = resolveModedLayerPolicy('static', routine(), st, { remainingCalls: null }, offRules)
    expect(r.executed).toEqual(staticLayerPolicy())
    expect(r.shadow).toBeUndefined()
    expect(r.executedTier).toBe('T2')
  })

  it('shadow executes exactly what static executes, and records what adaptive would do', () => {
    const s = routine()
    const stat = resolveModedLayerPolicy('static', s, st, { remainingCalls: 0 }, offRules)
    const shadow = resolveModedLayerPolicy('shadow', s, st, { remainingCalls: 0 }, offRules)
    expect(shadow.executed).toEqual(stat.executed)
    expect(shadow.executedTier).toBe(stat.executedTier)
    expect(shadow.shadow?.tier).toBe('T1')
    expect(shadow.shadow?.policy.semantic_contradiction.decision).toBe('off')
    expect(shadow.shadow?.policy.semantic_contradiction.trigger).toBe('test_off')
  })

  it('shadow equals static for every risk/trivial/tool combination', () => {
    for (const riskLevel of RISKS)
      for (const isTrivial of [true, false])
        for (const tools of [[], ['write_file']]) {
          const s = routine({ riskLevel, isTrivial, consequentialTools: new Set(tools) })
          const a = resolveModedLayerPolicy('static', s, st, { remainingCalls: 2 }, offRules)
          const b = resolveModedLayerPolicy('shadow', s, st, { remainingCalls: 2 }, offRules)
          expect(b.executed).toEqual(a.executed)
          expect(b.executedTier).toBe(a.executedTier)
        }
  })

  it('adaptive executes the resolved policy and tier', () => {
    const r = resolveModedLayerPolicy('adaptive', routine(), st, { remainingCalls: null }, offRules)
    expect(r.executed.semantic_contradiction.decision).toBe('off')
    expect(r.executedTier).toBe('T1')
  })

  it('a throwing rule never breaks shadow or adaptive', () => {
    const bad: PolicyRules = { semantic_contradiction: () => { throw new Error('boom') } }
    expect(resolveModedLayerPolicy('shadow', routine(), st, { remainingCalls: null }, bad).executed).toEqual(staticLayerPolicy())
    expect(resolveModedLayerPolicy('adaptive', routine(), st, { remainingCalls: null }, bad).executed).toEqual(staticLayerPolicy())
  })
})
