// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { ProbeCertificate } from './engagement-probe.js'
import type { LayerRun } from './layer-value.js'
import { analyzeCell, checkInvalidRows, d2Bar, mechanismsForCell, perCategory, recheckCertificates, renderAnalysisMarkdown } from './adaptive-analysis.js'
import { pairRuns } from './layer-value.js'

const CERT = (mechanism: string, certified = true): ProbeCertificate => ({ mechanism, certified, thresholds: [], failed: certified ? [] : ['engagement: low'], nonDiagnosticTasks: [], stressRuns: 30 })

function run(taskId: string, arm: string, seed: number, over: Partial<LayerRun> = {}): LayerRun {
  return { feature: 'f', taskId, arm, seed, category: 'general', riskLevel: 'LOW', turnShape: 'single', success: true, hallucination: null, unauthorizedEffect: null, recovered: null, invalid: false, firedLayers: [], llmCalls: 3, costUsd: 0.01, latencyMs: 100, ...over }
}

/** `n` tasks × 3 seeds in `category`; candidate costs `candCost`, succeeds unless in `candFail` first tasks; control fails first `ctlFail`. */
function cat(category: string, n: number, o: { candCost: number; candFail?: number; ctlFail?: number; invalidOn?: number; fired?: boolean }): LayerRun[] {
  const out: LayerRun[] = []
  for (let t = 0; t < n; t++)
    for (let s = 1; s <= 3; s++) {
      const id = `${category}-${t}`
      out.push(run(id, 'flagOn', s, { category, costUsd: 0.01, success: t >= (o.ctlFail ?? 0), firedLayers: o.fired === false ? [] : ['contradiction'] }))
      out.push(run(id, 'adaptivePolicy', s, { category, costUsd: o.candCost, success: t >= (o.candFail ?? 0), invalid: t * 3 + s <= (o.invalidOn ?? 0), firedLayers: o.fired === false ? [] : ['contradiction'] }))
    }
  return out
}

const CELL = { feature: 'adaptive-vs-alwayson-probes', onArm: 'adaptivePolicy', offArm: 'flagOn', mechanisms: ['semantic_contradiction'] }
const LAYERS = { semantic_contradiction: 'contradiction' }
const pairsOf = (rs: LayerRun[]) => pairRuns(rs, 'adaptivePolicy', 'flagOn')

describe('d2Bar', () => {
  it('passes when success is non-inferior and cost is ≥25% lower', () => {
    const r = d2Bar(pairsOf(cat('a', 50, { candCost: 0.006, ctlFail: 15, candFail: 15 })))
    expect(r.successNonInferior).toBe(true)
    expect(r.costReduction).toBeCloseTo(0.4)
    expect(r.pass).toBe(true)
  })
  it('fails on cost when the saving is < 25%', () => {
    const r = d2Bar(pairsOf(cat('a', 50, { candCost: 0.009 })))
    expect(r.costOk).toBe(false)
    expect(r.pass).toBe(false)
  })
  it('fails when the success lower CI is below -3pt even at big savings', () => {
    const r = d2Bar(pairsOf(cat('a', 50, { candCost: 0.001, candFail: 20 })))
    expect(r.successNonInferior).toBe(false)
    expect(r.pass).toBe(false)
  })
})

describe('perCategory', () => {
  it('catches a category regression hidden by a healthy average', () => {
    const rs = [...cat('easy', 300, { candCost: 0.005 }), ...cat('adv_injection', 4, { candCost: 0.005, candFail: 3 })]
    const pairs = pairsOf(rs)
    expect(d2Bar(pairs).successNonInferior).toBe(true) // the average looks fine
    const cats = perCategory(pairs)
    expect(cats.find((c) => c.category === 'adv_injection')?.regressed).toBe(true)
    expect(cats.find((c) => c.category === 'easy')?.regressed).toBe(false)
  })
  it('omits categories with too few pairs', () => {
    expect(perCategory(pairsOf(cat('tiny', 0, { candCost: 0.01 })))).toEqual([])
  })
})

describe('checkInvalidRows', () => {
  it('refuses an arm with > 5% invalid rows', () => {
    const rs = cat('a', 50, { candCost: 0.005, invalidOn: 8 }) // 3 of 30
    const c = checkInvalidRows(rs, ['adaptivePolicy', 'flagOn'])
    expect(c.ok).toBe(false)
    expect(c.reason).toContain('adaptivePolicy')
  })
  it('accepts exactly 5%', () => {
    expect(checkInvalidRows(cat('a', 50, { candCost: 0.005, invalidOn: 1 }), ['adaptivePolicy']).ok).toBe(true) // 1/30 = 3.3%
  })
})

describe('recheckCertificates', () => {
  const good = pairsOf(cat('a', 50, { candCost: 0.005, ctlFail: 20 }))
  it('no certificate on record ⇒ not ok', () => {
    expect(recheckCertificates(['semantic_contradiction'], {}, good, LAYERS).reason).toContain('no adequacy certificate')
  })
  it('a failed certificate ⇒ not ok', () => {
    expect(recheckCertificates(['semantic_contradiction'], { semantic_contradiction: CERT('semantic_contradiction', false) }, good, LAYERS).ok).toBe(false)
  })
  it('certificate ok but the actual run never engaged ⇒ not ok', () => {
    const p = pairsOf(cat('a', 50, { candCost: 0.005, ctlFail: 20, fired: false }))
    expect(recheckCertificates(['semantic_contradiction'], { semantic_contradiction: CERT('semantic_contradiction') }, p, LAYERS).reason).toContain('engaged')
  })
  it('certificate ok but the control had no headroom on the actual run ⇒ not ok', () => {
    const p = pairsOf(cat('a', 50, { candCost: 0.005, ctlFail: 0 }))
    expect(recheckCertificates(['semantic_contradiction'], { semantic_contradiction: CERT('semantic_contradiction') }, p, LAYERS).reason).toContain('headroom')
  })
  it('passes with a certificate, engagement and headroom; no mechanisms needs none', () => {
    expect(recheckCertificates(['semantic_contradiction'], { semantic_contradiction: CERT('semantic_contradiction') }, good, LAYERS).ok).toBe(true)
    expect(recheckCertificates([], {}, good).ok).toBe(true)
  })
})

describe('analyzeCell', () => {
  const certs = { semantic_contradiction: CERT('semantic_contradiction') }
  it('a slice with no certificate is UNTESTED and not scored', () => {
    const r = analyzeCell(CELL, cat('a', 50, { candCost: 0.005, ctlFail: 20 }), {}, LAYERS)
    expect(r.status).toBe('UNTESTED')
    expect(r.overall).toBeUndefined()
    expect(r.d2Pass).toBeUndefined()
  })
  it('too many invalid rows refuses to read the run, before the certificate is even consulted', () => {
    const r = analyzeCell(CELL, cat('a', 50, { candCost: 0.005, ctlFail: 20, invalidOn: 30 }), {}, LAYERS)
    expect(r.status).toBe('REFUSED_INVALID_ROWS')
  })
  it('a certified, healthy run is SCORED and passes D2', () => {
    const r = analyzeCell(CELL, cat('a', 50, { candCost: 0.005, ctlFail: 20, candFail: 20 }), certs, LAYERS)
    expect(r.status).toBe('SCORED')
    expect(r.d2Pass).toBe(true)
  })
  it('an overall pass with one regressed category is not a D2 pass', () => {
    const rs = [...cat('easy', 300, { candCost: 0.005, ctlFail: 90, candFail: 90 }), ...cat('adv_injection', 4, { candCost: 0.005, candFail: 3 })]
    const r = analyzeCell({ ...CELL, mechanisms: [] }, rs, {}, LAYERS)
    expect(r.overall?.pass).toBe(true)
    expect(r.d2Pass).toBe(false)
    expect(r.reason).toContain('adv_injection')
  })
  it('renders a table row per cell', () => {
    const md = renderAnalysisMarkdown([analyzeCell(CELL, cat('a', 50, { candCost: 0.005, ctlFail: 20 }), {}, LAYERS)])
    expect(md).toContain('UNTESTED')
  })
})

describe('mechanismsForCell', () => {
  it('only the all-probes adaptive cells need certificates', () => {
    expect(mechanismsForCell('adaptive-vs-alwayson-probes').length).toBeGreaterThan(5)
    expect(mechanismsForCell('adaptive-vs-alwayson-full')).toEqual([])
    expect(mechanismsForCell('adaptive-vs-alwayson-smoke')).toEqual([])
  })
  it('a split all-probes part needs only the layers whose probe slices it covers', () => {
    const probeSlices = new Map<string, string | null>([
      ['probe-change-review', 'probe_change_review'],
      ['probe-semantic-contradiction', 'probe_contradiction,probe_belief_trail'],
      ['probe-injection', 'probe_injection'],
      ['probe-verification', 'probe_verification'],
    ])
    const a = mechanismsForCell('adaptive-vs-alwayson-probes-a', 'probe_change_review,probe_contradiction,probe_belief_trail', probeSlices)
    expect(a).toContain('change_review')
    expect(a).toContain('semantic_contradiction')
    expect(a).not.toContain('injection_detection')
    const b = mechanismsForCell('adaptive-vs-bare-probes-b', 'probe_injection,probe_verification', probeSlices)
    expect(b).toEqual(['injection_detection', 'verification'])
  })
})
