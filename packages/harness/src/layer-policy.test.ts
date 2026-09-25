import { describe, it, expect } from 'vitest'
import {
  DECISION_ORDER, ESCALATION_LAYERS, FLOOR_LAYERS, LAYER_CLASS, resolveLayerPolicy, staticLayerPolicy,
  type Decision, type Layer, type PolicyRules,
} from './layer-policy.js'
import { computeRunState, type TurnSignals } from './turn-signals.js'
import type { LayerActivityEvent } from './harness-runtime.js'

const RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const
const AMBIG = ['none', 'high', 'unknown'] as const
const POSTURE = ['informational', 'corrective', 'unknown'] as const
const TRENDS = ['improving', 'degrading', 'unknown'] as const
const BOOLS = [false, true] as const
const FAILS = [0, 3]
const BUDGETS = [null, 1, 0]
const TOOLSETS = [[], ['write_file']]

const DECISIONS: Decision[] = ['off', 'cheap', 'full']
/** Adversarial rules: every escalation proposes every decision, depending on signals — the clamp must still hold. */
function rulesFor(d: Decision): PolicyRules {
  const r: PolicyRules = {}
  for (const l of ESCALATION_LAYERS) r[l] = () => ({ decision: d, trigger: `rule_${d}` })
  return r
}

interface Case { signals: TurnSignals; budget: number | null }
function* allCases(): Generator<Case> {
  for (const riskLevel of RISKS)
    for (const ambiguity of AMBIG)
      for (const userPosture of POSTURE)
        for (const needsGrounding of BOOLS)
          for (const pushbackOnPriorTurn of BOOLS)
            for (const statesConstraint of BOOLS)
              for (const tools of TOOLSETS)
                for (const untrusted of BOOLS)
                  for (const trend of TRENDS)
                    for (const fails of FAILS)
                      for (const budget of BUDGETS) {
                        yield {
                          budget,
                          signals: {
                            riskLevel, taskCount: 1, hasDurablePlan: false, consequentialTools: new Set(tools),
                            ambiguity, userPosture, needsGrounding, pushbackOnPriorTurn, statesConstraint,
                            runState: {
                              ...computeRunState({ outcomes: Array(fails).fill(true), untrustedContentInContext: untrusted }),
                              diagnosticsTrend: trend,
                            },
                          },
                        }
                      }
}

describe('layer classes', () => {
  it('every layer has exactly one class and the floor list matches the table', () => {
    expect(FLOOR_LAYERS.every((l) => LAYER_CLASS[l] === 'floor')).toBe(true)
    expect(ESCALATION_LAYERS.every((l) => LAYER_CLASS[l] === 'escalation')).toBe(true)
    expect(Object.values(LAYER_CLASS).filter((c) => c === 'floor').length).toBe(FLOOR_LAYERS.length)
  })
  it('floor layers are undecidable by construction (type-level)', () => {
    // @ts-expect-error a floor layer is not a valid key of PolicyRules
    const bad: PolicyRules = { control_state: () => ({ decision: 'off', trigger: 'x' }) }
    void bad
    // Even if a caller bypasses the type system, the resolver ignores it.
    const sig = allCases().next().value!.signals
    const p = resolveLayerPolicy(sig, sig.runState, { remainingCalls: null }, bad)
    for (const l of FLOOR_LAYERS) expect(p[l].decision).toBe('full')
  })
})

describe('exhaustive enumeration of the signal space', () => {
  let n = 0
  it('holds monotone restriction, totality, determinism and the AL-1 security rule everywhere', () => {
    const stat = staticLayerPolicy()
    for (const { signals, budget } of allCases()) {
      for (const d of DECISIONS) {
        const rules = rulesFor(d)
        const b = { remainingCalls: budget }
        const p = resolveLayerPolicy(signals, signals.runState, b, rules)
        n++
        // totality
        expect(Object.keys(p).sort()).toEqual(Object.keys(stat).sort())
        for (const l of Object.keys(p) as Layer[]) {
          expect(p[l].trigger.length).toBeGreaterThan(0)
          // monotone restriction: never less restrictive than static
          expect(DECISION_ORDER[p[l].decision]).toBeLessThanOrEqual(DECISION_ORDER[stat[l].decision])
          if (LAYER_CLASS[l] !== 'escalation') expect(p[l]).toEqual(stat[l])
        }
        // AL-1 security rule
        const provenSafe = signals.runState!.untrustedContentInContext === false || signals.consequentialTools.size === 0
        if (!provenSafe) expect(p.injection_detection.decision).toBe('full')
        // determinism
        expect(resolveLayerPolicy(signals, signals.runState, b, rules)).toEqual(p)
      }
    }
    expect(n).toBeGreaterThan(10000)
  })
})

describe('fail-safe and budget', () => {
  const sig: TurnSignals = { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set() }
  it('a throwing rule resolves to the static policy (AL-4)', () => {
    const p = resolveLayerPolicy(sig, undefined, { remainingCalls: null }, {
      failure_match: () => ({ decision: 'off', trigger: 't' }),
      change_review: () => { throw new Error('boom') },
    })
    expect(p).toEqual(staticLayerPolicy())
  })
  it('an invalid decision resolves to static', () => {
    const p = resolveLayerPolicy(sig, undefined, { remainingCalls: null }, {
      failure_match: () => ({ decision: 'bogus' as Decision, trigger: 't' }),
    })
    expect(p).toEqual(staticLayerPolicy())
  })
  it('no rules and an unlimited budget is exactly static', () => {
    expect(resolveLayerPolicy(sig, undefined, { remainingCalls: null })).toEqual(staticLayerPolicy())
  })
  it('an exhausted budget degrades escalations to cheap (≡ off without a cheap form) and says so', () => {
    const p = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: 0 })
    expect(p.criterion_coverage).toMatchObject({ decision: 'cheap', trigger: 'budget_exhausted' })
    expect(p.change_review).toMatchObject({ decision: 'off', trigger: 'budget_exhausted' })
    expect(p.control_state.decision).toBe('full')
  })
  it('injection detection stays full under untrusted content with tools, even when exhausted or ruled off', () => {
    const risky: TurnSignals = { ...sig, consequentialTools: new Set(['write_file']) }
    const st = computeRunState({ untrustedContentInContext: true })
    const p = resolveLayerPolicy(risky, st, { remainingCalls: 0 }, { injection_detection: () => ({ decision: 'off', trigger: 'x' }) })
    expect(p.injection_detection.decision).toBe('full')
    const safe = resolveLayerPolicy(sig, computeRunState(), { remainingCalls: 0 })
    expect(safe.injection_detection.decision).toBe('off')
  })
})

describe('LayerActivityEvent', () => {
  it('the new fields are additive: an old-shape event still type-checks', () => {
    const old: LayerActivityEvent = { layer: 'verification', fired: true, reason: 'ok' }
    const next: LayerActivityEvent = { ...old, decision: 'full', trigger: 'static', llmCalls: 0, tokens: 0 }
    expect(next.layer).toBe(old.layer)
  })
})

import { resolveGate, reevaluateLayerPolicy, staticLayerPolicy as _static } from './layer-policy.js'

describe('AL8b ad hoc gates', () => {
  const sig = { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set<string>() } as never
  it('static / missing policy returns today\'s boolean unchanged', () => {
    for (const b of [true, false]) {
      expect(resolveGate(undefined, 'hypothesis_display', b)).toEqual({ on: b })
      expect(resolveGate(_static(), 'belief_trail', b)).toEqual({ on: b })
    }
  })
  it('a non-static trigger can turn a gate off and on', () => {
    const p = { ..._static(), reviewer_adversarial: { decision: 'off', trigger: 'low_risk', reason: '' } } as never
    expect(resolveGate(p, 'reviewer_adversarial', true)).toEqual({ on: false, decision: 'off', trigger: 'low_risk' })
    const q = { reviewer_adversarial: { decision: 'full', trigger: 'soft_failure', reason: '' } } as never
    expect(resolveGate(q, 'reviewer_adversarial', false)).toEqual({ on: true, decision: 'full', trigger: 'soft_failure' })
  })
  it('a malformed policy entry falls back to static', () => {
    expect(resolveGate({ belief_trail: { decision: 'bogus', trigger: 'x' } } as never, 'belief_trail', true)).toEqual({ on: true })
  })
  it('re-evaluation picks up fresh state (escalate-on-evidence) and never throws', () => {
    const rules = { change_review: (c: { state?: { consecutiveFailures: number } }) => (c.state?.consecutiveFailures ?? 0) > 0 ? { decision: 'full', trigger: 'failures' } : { decision: 'off', trigger: 'calm' } } as never
    const calm = reevaluateLayerPolicy(_static(), sig, { consecutiveFailures: 0 } as never, { remainingCalls: null }, rules)
    const hot = reevaluateLayerPolicy(calm, sig, { consecutiveFailures: 2 } as never, { remainingCalls: null }, rules)
    expect(calm?.change_review.decision).toBe('off')
    expect(hot?.change_review.decision).toBe('full')
    expect(reevaluateLayerPolicy(undefined, sig, undefined, { remainingCalls: null }, rules)).toBeUndefined()
  })
})
