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
