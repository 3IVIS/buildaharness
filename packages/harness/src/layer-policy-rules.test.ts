import { describe, it, expect } from 'vitest'
import { ADAPTIVE_RULES_V1, isCalmTurn } from './layer-policy-rules.js'
import { resolveLayerPolicy, staticLayerPolicy, type PolicyContext } from './layer-policy.js'
import { computeRunState, type TurnSignals } from './turn-signals.js'

const tools = new Set(['write_file'])
const calm = (over: Partial<TurnSignals> = {}): TurnSignals => ({
  riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: tools, userPosture: 'informational', ...over,
})
const run = (signals: TurnSignals, state = computeRunState()) => resolveLayerPolicy(signals, state, { remainingCalls: null }, ADAPTIVE_RULES_V1)

describe('AL10 adaptive rules v1', () => {
  it('a calm LOW-risk single-task turn skips escalations with named triggers (skipped-with-trigger)', () => {
    const p = run(calm())
    expect(p.semantic_contradiction).toMatchObject({ decision: 'off', trigger: 'calm_low_risk' })
    expect(p.failure_match.decision).toBe('off')
    expect(p.criterion_coverage).toMatchObject({ decision: 'cheap', trigger: 'calm_low_risk' })
    expect(p.change_review.decision).toBe('off')
    expect(p.reviewer_adversarial).toMatchObject({ decision: 'off', trigger: 'low_risk_no_failure' })
    expect(p.decomposition_reframe).toMatchObject({ decision: 'off', trigger: 'single_step' })
    expect(p.model_inferred_facts).toMatchObject({ decision: 'off', trigger: 'calm_informational' })
  })

  it('escalates with a named trigger when the regime is entered', () => {
    expect(run(calm({ riskLevel: 'HIGH' })).reviewer_adversarial).toMatchObject({ decision: 'full', trigger: 'risk_medium_plus' })
    expect(run(calm({ statesConstraint: true })).change_review).toMatchObject({ decision: 'full', trigger: 'constraint_or_correction' })
    expect(run(calm({ taskCount: 3 })).decomposition_reframe).toMatchObject({ decision: 'full', trigger: 'needs_multi_step_plan' })
    expect(run(calm(), computeRunState({ turnDepth: 2 })).model_inferred_facts).toMatchObject({ decision: 'full', trigger: 'multi_turn_session' })
    expect(run(calm(), computeRunState({ outcomes: [true] })).reviewer_adversarial).toMatchObject({ decision: 'full', trigger: 'soft_verification_failure' })
  })

  it('a non-calm turn keeps the static behaviour for layers with no regime opinion', () => {
    const p = run(calm({ pushbackOnPriorTurn: true }))
    expect(p.semantic_contradiction.trigger).toBe('static')
    expect(p.criterion_coverage.decision).toBe('full')
  })

  it('injection detection: skipped only with a non-linguistic proof, otherwise held at full', () => {
    const noUntrusted = run(calm(), computeRunState({ untrustedContentInContext: false }))
    expect(noUntrusted.injection_detection).toMatchObject({ decision: 'off', trigger: 'no_untrusted_content' })
    const reaches = run(calm(), computeRunState({ untrustedContentInContext: true }))
    expect(reaches.injection_detection).toMatchObject({ decision: 'full', trigger: 'untrusted_reaches_tools' })
    const noToolsButUntrusted = run(calm({ consequentialTools: new Set() }), computeRunState({ untrustedContentInContext: true }))
    expect(noToolsButUntrusted.injection_detection.decision).toBe('off')
  })

  it('missing signals mean no opinion: injection with no run state stays static', () => {
    expect(resolveLayerPolicy(calm(), undefined, { remainingCalls: null }, ADAPTIVE_RULES_V1).injection_detection.trigger).toBe('static')
  })

  it('never touches floor layers and never exceeds static (AL-1)', () => {
    const p = run(calm())
    const s = staticLayerPolicy()
    for (const l of ['control_state', 'approval_staging', 'tool_policy', 'diagnostics', 'hypothesis', 'mandatory_verification', 'supervisor'] as const) {
      expect(p[l]).toEqual(s[l])
    }
  })

  it('isCalmTurn rejects risk, multi-task, ambiguity and failures', () => {
    const ctx = (signals: TurnSignals, state = computeRunState()): PolicyContext => ({ signals, state, budget: { remainingCalls: null } })
    expect(isCalmTurn(ctx(calm()))).toBe(true)
    expect(isCalmTurn(ctx(calm({ riskLevel: 'MEDIUM' })))).toBe(false)
    expect(isCalmTurn(ctx(calm({ taskCount: 2 })))).toBe(false)
    expect(isCalmTurn(ctx(calm({ ambiguity: 'some' })))).toBe(false)
    expect(isCalmTurn(ctx(calm(), computeRunState({ outcomes: [true] })))).toBe(false)
  })

  it('a throwing rule resolves the whole policy to static (AL-4)', () => {
    const p = resolveLayerPolicy(calm(), computeRunState(), { remainingCalls: null }, { change_review: () => { throw new Error('x') } })
    expect(p).toEqual(staticLayerPolicy())
  })
})
