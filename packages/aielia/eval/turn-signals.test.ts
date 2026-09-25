import { describe, it, expect } from 'vitest'
import { TURN_SIGNAL_TURNS } from './turn-signals-corpus.js'
import {
  SIGNAL_FIELDS, reconcileLabels, scoreFields, sampleForReview, costFloor, smallerModelHoldsBar, renderAccuracyTable, type LabelledTurn,
} from './turn-signals.js'

describe('turn-signals corpus', () => {
  it('has >=120 unique turns covering every field, with non-English', () => {
    expect(TURN_SIGNAL_TURNS.length).toBeGreaterThanOrEqual(120)
    expect(new Set(TURN_SIGNAL_TURNS.map((t) => t.id)).size).toBe(TURN_SIGNAL_TURNS.length)
    for (const f of SIGNAL_FIELDS) expect(TURN_SIGNAL_TURNS.filter((t) => t.covers.includes(f)).length).toBeGreaterThanOrEqual(15)
    expect(TURN_SIGNAL_TURNS.filter((t) => t.lang !== 'en').length).toBeGreaterThanOrEqual(20)
  })
})

describe('reconcileLabels', () => {
  it('keeps only fields where both passes agree', () => {
    expect(reconcileLabels({ needsGrounding: true, userPosture: 'directive' }, { needsGrounding: true, userPosture: 'exploratory' })).toEqual({ needsGrounding: true })
  })
  it('drops everything if a pass failed', () => {
    expect(reconcileLabels(null, { needsGrounding: true })).toEqual({})
  })
})

const turn = (id: string, labels: LabelledTurn['labels']): LabelledTurn => ({ id, lang: 'en', message: id, covers: [], labels, labeller: 't' })

describe('scoreFields', () => {
  it('scores per field, skips unlabelled, applies the 85% bar', () => {
    const labelled = Array.from({ length: 20 }, (_, i) => turn(`t${i}`, { statesConstraint: true, needsGrounding: i < 10 }))
    const preds: Record<string, { statesConstraint: boolean; needsGrounding: boolean }> = {}
    labelled.forEach((t, i) => (preds[t.id] = { statesConstraint: i !== 0, needsGrounding: i < 5 }))
    const r = Object.fromEntries(scoreFields(labelled, preds).map((f) => [f.field, f]))
    expect(r.statesConstraint).toMatchObject({ scored: 20, agreed: 19, usable: true })
    expect(r.needsGrounding.usable).toBe(false)
    expect(r.userPosture).toMatchObject({ scored: 0, accuracy: null, usable: false })
  })
})

describe('sampleForReview', () => {
  it('is deterministic, sized and duplicate-free', () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    const s = sampleForReview(items, 30, 7)
    expect(s).toEqual(sampleForReview(items, 30, 7))
    expect(new Set(s).size).toBe(30)
  })
})

describe('cost floor and smaller-model gate', () => {
  it('computes shares and tolerates unknown totals', () => {
    expect(costFloor({ classifierTokens: 200, turnTokens: 1000, classifierMs: 500, turnMs: 0 })).toMatchObject({ tokenShare: 0.2, latencyShare: null })
  })
  it('rejects a small model that drops a usable field under the bar', () => {
    const f = (accuracy: number) => SIGNAL_FIELDS.map((field) => ({ field, scored: 10, agreed: accuracy * 10, accuracy, usable: accuracy >= 0.85 }))
    expect(smallerModelHoldsBar(f(0.9), f(0.9))).toBe(true)
    expect(smallerModelHoldsBar(f(0.9), f(0.8))).toBe(false)
  })
  it('renders the spot-check status', () => {
    const md = renderAccuracyTable({ classifierModel: 'm', labeller: 'l', totalTurns: 1, fields: [], ownerSpotCheckDone: false })
    expect(md).toContain('NOT done')
  })
})
