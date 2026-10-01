import { describe, it, expect } from 'vitest'
import {
  buildLayerOutcomeRow, buildFeedbackRow, buildShadowRow, summarizeLayerYield, summarizeShadow, parseTelemetryLog,
} from './layer-outcome.js'
import { staticLayerPolicy, resolveLayerPolicy, LAYER_CALL_COST } from './layer-policy.js'
import type { TurnSignals, RunState } from './turn-signals.js'

const SECRET = 'my password is hunter2 and my address is 12 Elm St'
const sig: TurnSignals = { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: new Set() }
const st: RunState = {
  consecutiveFailures: 0, turnDepth: 0, cumulativeSpend: 0, sessionBudget: null,
  diagnosticsTrend: 'unknown', verificationTrend: 'unknown', toolReliability: {}, untrustedContentInContext: false,
}

describe('AL9b outcome log', () => {
  it('AL-10: a fixture carrying message text and facts yields a row containing none of it', () => {
    const row = buildLayerOutcomeRow({
      runId: 'run-1', mode: 'shadow', tier: 'T2', completed: true,
      changedLayers: ['contradiction'],
      activity: [
        { layer: 'contradiction', fired: true, reason: SECRET, llmCalls: 1, tokens: 120, message: SECRET, facts: [SECRET] },
        { layer: SECRET, fired: true, llmCalls: 5 },
        { layer: 'verification', fired: false, reason: SECRET },
      ] as never,
    })!
    const json = JSON.stringify(row)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('Elm St')
    expect(json).not.toContain('message')
    expect(row.layers.map(l => l.layer)).toEqual(['contradiction', 'verification'])
    expect(row.layers[0]).toEqual({ layer: 'contradiction', fired: true, calls: 1, tokens: 120, changed: true, actedOn: true })
  })

  it('AL-10: an unsafe runId/mode never leaks; a bad runId yields no row', () => {
    expect(buildLayerOutcomeRow({ runId: SECRET, mode: 'static', tier: 'T2', activity: [], completed: true })).toBeUndefined()
    expect(buildLayerOutcomeRow({ runId: 'r', mode: SECRET, tier: 'T2', activity: [], completed: true })!.mode).toBe('unknown')
    expect(buildFeedbackRow(SECRET, true)).toBeUndefined()
  })

  it('a finding on a paused turn is changed but not acted on; an unfired layer is never changed', () => {
    const row = buildLayerOutcomeRow({
      runId: 'r', mode: 'static', tier: 'T2', completed: false, changedLayers: ['contradiction', 'recovery'],
      activity: [{ layer: 'contradiction', fired: true }, { layer: 'recovery', fired: false }],
    })!
    expect(row.layers.find(l => l.layer === 'contradiction')).toMatchObject({ changed: true, actedOn: false })
    expect(row.layers.find(l => l.layer === 'recovery')).toMatchObject({ changed: false, actedOn: false })
  })

  it('aggregates per-layer yield and folds in next-turn correction feedback', () => {
    const a = buildLayerOutcomeRow({ runId: 'a', mode: 'static', tier: 'T2', completed: true, changedLayers: ['contradiction'], activity: [{ layer: 'contradiction', fired: true, llmCalls: 2, tokens: 10 }] })!
    const b = buildLayerOutcomeRow({ runId: 'b', mode: 'static', tier: 'T2', completed: true, activity: [{ layer: 'contradiction', fired: true, llmCalls: 2, tokens: 10 }] })!
    const y = summarizeLayerYield([a, b, buildFeedbackRow('a', true)!, buildFeedbackRow('b', false)!])
    expect(y).toHaveLength(1)
    expect(y[0]).toMatchObject({ layer: 'contradiction', turns: 2, fired: 2, calls: 4, tokens: 20, changed: 1, actedOn: 1, correctedNext: 1, knownNext: 2, changesPerCall: 0.25 })
  })
})

describe('AL9b shadow telemetry', () => {
  it('records disagreements, calls saved and correction coincidence', () => {
    const executed = staticLayerPolicy()
    const shadow = resolveLayerPolicy(sig, st, { remainingCalls: 2 })
    const row = buildShadowRow({ runId: 's1', executed, executedTier: 'T2', shadow: { policy: shadow, tier: 'T1' }, layerCosts: LAYER_CALL_COST, observedCalls: 4, verificationFailed: false })!
    expect(row.disagreements.length).toBeGreaterThan(0)
    expect(row.shadowCalls).toBeLessThan(row.executedCalls)
    expect(JSON.stringify(row)).not.toContain('hunter2')
    const rep = summarizeShadow([row, buildFeedbackRow('s1', true)!])
    expect(rep.turns).toBe(1)
    expect(rep.callsSaved).toBe(row.executedCalls - row.shadowCalls)
    const l = rep.layers.find(x => x.wouldSkip > 0)!
    expect(l.disagreementRate).toBe(1)
    expect(l.skipCoincidedWithCorrection).toBe(1)
    expect(l.skipKnown).toBe(1)
  })

  it('no disagreement ⇒ empty report layers; parseTelemetryLog skips junk', () => {
    const p = staticLayerPolicy()
    const row = buildShadowRow({ runId: 's2', executed: p, executedTier: 'T2', shadow: { policy: p, tier: 'T2' }, layerCosts: LAYER_CALL_COST, observedCalls: 0, verificationFailed: false })!
    expect(row.disagreements).toEqual([])
    const rows = parseTelemetryLog(`not json\n${JSON.stringify(row)}\n{"kind":"other"}`)
    expect(rows).toHaveLength(1)
    expect(summarizeShadow(rows).layers).toEqual([])
  })
})

describe('measured layer use (2026-10-01)', () => {
  it('layerUse becomes one outcome entry per instrumented layer with real calls and tokens; none given ⇒ none added', () => {
    const withUse = buildLayerOutcomeRow({
      runId: 'm1', mode: 'shadow', tier: 'T2', activity: [{ layer: 'contradiction', fired: false }], completed: true,
      layerUse: { failure_match: { calls: 2, tokens: 340 }, change_review: { calls: 0, tokens: 0 }, 'bad id!': { calls: 9, tokens: 9 } },
    })!
    expect(withUse.layers.find(l => l.layer === 'failure_match')).toMatchObject({ fired: true, calls: 2, tokens: 340, changed: false })
    expect(withUse.layers.find(l => l.layer === 'change_review')).toMatchObject({ fired: false, calls: 0 })
    expect(withUse.layers.some(l => l.layer === 'bad id!')).toBe(false)
    const without = buildLayerOutcomeRow({ runId: 'm2', mode: 'shadow', tier: 'T2', activity: [{ layer: 'contradiction', fired: false }], completed: true })!
    expect(without.layers.map(l => l.layer)).toEqual(['contradiction'])
    const y = summarizeLayerYield([withUse])
    expect(y.find(r => r.layer === 'failure_match')).toMatchObject({ calls: 2, tokens: 340 })
  })

  it('summarizeShadow reports measured calls and how many fell on layers the shadow policy would skip; a legacy row without observedByLayer counts none', () => {
    const executed = staticLayerPolicy()
    const shadow = { ...executed, failure_match: { decision: 'off' as const, trigger: 'calm_low_risk', reason: 'x' }, semantic_contradiction: { decision: 'off' as const, trigger: 'calm_low_risk', reason: 'x' } }
    const measured = buildShadowRow({ runId: 'm3', executed, executedTier: 'T2', shadow: { policy: shadow, tier: 'T2' }, layerCosts: LAYER_CALL_COST, observedCalls: 3, observedByLayer: { failure_match: 2, change_review: 1 }, verificationFailed: false })!
    const legacy = buildShadowRow({ runId: 'm4', executed, executedTier: 'T2', shadow: { policy: shadow, tier: 'T2' }, layerCosts: LAYER_CALL_COST, observedCalls: 0, verificationFailed: false })!
    expect(measured.observedByLayer).toEqual({ failure_match: 2, change_review: 1 })
    expect(legacy.observedByLayer).toBeUndefined()
    const rep = summarizeShadow([measured, legacy])
    expect(rep.observedCalls).toBe(3)
    expect(rep.observedCallsSkipped).toBe(2) // only failure_match's 2 calls were on a layer shadow would skip
    expect(rep.layers.find(l => l.layer === 'failure_match')!.observedCallsSkipped).toBe(2)
    expect(rep.layers.find(l => l.layer === 'semantic_contradiction')!.observedCallsSkipped).toBe(0)
  })
})
