// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { ProbeCertificate } from './engagement-probe.js'
import {
  analyzeRegime,
  assignState,
  buildLayerValueMap,
  pairedDelta,
  pairRuns,
  parseLayerSpecs,
  regimeKeys,
  renderLayerValueMarkdown,
  runFromTranscript,
  type LayerRun,
  type LayerSource,
} from './layer-value.js'
import { MECHANISM_IDS } from '../corpus/mechanisms.js'

const SOURCE: LayerSource = { feature: 'f', mechanism: 'semantic_contradiction', onArm: 'flagOn', offArm: 'off', activityLayer: 'contradiction' }
const CERT_OK = { mechanism: 'semantic_contradiction', certified: true, thresholds: [], failed: [], nonDiagnosticTasks: [], stressRuns: 30 } as ProbeCertificate
const CERT_BAD = { ...CERT_OK, certified: false, failed: ['engagement: x'] } as ProbeCertificate

function run(taskId: string, arm: string, seed: number, over: Partial<LayerRun> = {}): LayerRun {
  return { feature: 'f', taskId, arm, seed, category: 'adv_contradiction', riskLevel: 'LOW', turnShape: 'single', success: true, hallucination: null, unauthorizedEffect: null, recovered: null, invalid: false, firedLayers: [], llmCalls: 3, costUsd: 0.01, latencyMs: 100, ...over }
}

/** `tasks` × 3 seeds: control succeeds on the first `ctlPass` tasks; layer fixes `fixed` of the rest; fires on all. */
function fixture(tasks: number, ctlPass: number, fixed: number, fires = true): LayerRun[] {
  const out: LayerRun[] = []
  for (let t = 0; t < tasks; t++) {
    for (let s = 1; s <= 3; s++) {
      out.push(run(`t${t}`, 'off', s, { success: t < ctlPass }))
      out.push(run(`t${t}`, 'flagOn', s, { success: t < ctlPass || t < ctlPass + fixed, firedLayers: fires ? ['contradiction'] : [], llmCalls: 4, costUsd: 0.015 }))
    }
  }
  return out
}

const pairsOf = (runs: LayerRun[]) => pairRuns(runs, 'flagOn', 'off')

describe('pairedDelta', () => {
  it('is null-CI below two pairs and floors the SE when all pairs agree', () => {
    expect(pairedDelta([]).ci).toBeNull()
    expect(pairedDelta([1]).ci).toBeNull()
    const d = pairedDelta([0, 0, 0, 0])
    expect(d.mean).toBe(0)
    expect(d.ci![1]).toBeGreaterThan(0) // never a zero-width interval
  })
  it('excludes 0 for a consistent positive effect', () => {
    const d = pairedDelta([1, 1, 1, 1, 1, 1, 0, 1, 1, 1])
    expect(d.ci![0]).toBeGreaterThan(0)
  })
})

describe('pairRuns / regimeKeys', () => {
  it('pairs on task+seed within a feature and ignores invalid runs', () => {
    const runs = [run('a', 'off', 1), run('a', 'flagOn', 1), run('a', 'off', 2), run('a', 'flagOn', 2, { invalid: true }), run('b', 'flagOn', 1)]
    expect(pairRuns(runs, 'flagOn', 'off')).toHaveLength(1)
  })
  it('emits overall, marginal and full-cell regimes', () => {
    expect(regimeKeys({ category: 'c', riskLevel: 'HIGH', turnShape: 'multi' })).toEqual(['*', 'category=c', 'risk=HIGH', 'shape=multi', 'category=c · risk=HIGH · shape=multi'])
  })
})

describe('assignState', () => {
  const base = { engagement: 0.9, headroom: 0.5, target: { n: 30, mean: 0.3, ci: [0.1, 0.5] as [number, number] }, certified: true, hasCertificate: true, justifyingEffect: 0.1 }
  it('UNTESTED without engagement or headroom, regardless of certificate', () => {
    expect(assignState({ ...base, engagement: 0.1 }).state).toBe('UNTESTED')
    expect(assignState({ ...base, headroom: 0.02 }).state).toBe('UNTESTED')
    expect(assignState({ ...base, headroom: null }).state).toBe('UNTESTED')
  })
  it('missing certificate caps the state at INCONCLUSIVE-UNDERPOWERED even with a clean CI', () => {
    expect(assignState({ ...base, hasCertificate: false, certified: false }).state).toBe('INCONCLUSIVE-UNDERPOWERED')
    expect(assignState({ ...base, certified: false }).state).toBe('INCONCLUSIVE-UNDERPOWERED')
  })
  it('certified: HELPS / NULL / harmful NULL / wide CI', () => {
    expect(assignState(base).state).toBe('HELPS-IN-REGIME')
    expect(assignState({ ...base, target: { n: 30, mean: 0, ci: [-0.05, 0.05] } }).state).toBe('NULL-IN-TESTED-REGIME')
    const harm = assignState({ ...base, target: { n: 30, mean: -0.3, ci: [-0.5, -0.1] } })
    expect(harm).toMatchObject({ state: 'NULL-IN-TESTED-REGIME', harmful: true })
    expect(assignState({ ...base, target: { n: 6, mean: 0.1, ci: [-0.4, 0.6] } }).state).toBe('INCONCLUSIVE-UNDERPOWERED')
    expect(assignState({ ...base, target: { n: 1, mean: 1, ci: null } }).state).toBe('INCONCLUSIVE-UNDERPOWERED')
  })
})

describe('analyzeRegime', () => {
  it('computes engagement, headroom, MDE, distinct tasks and cost/call deltas', () => {
    const r = analyzeRegime('*', pairsOf(fixture(10, 5, 5)), SOURCE, CERT_OK)
    expect(r.pairs).toBe(30)
    expect(r.distinctTasks).toBe(10)
    expect(r.engagement).toBe(1)
    expect(r.headroom).toBe(0.5)
    expect(r.mde).toBeGreaterThan(0)
    expect(r.targetDelta.mean).toBeCloseTo(0.5)
    expect(r.llmCallDelta).toBeCloseTo(1)
    expect(r.costDeltaUsd).toBeCloseTo(0.005)
    expect(r.state).toBe('HELPS-IN-REGIME')
  })
  it('falls back to the LLM-call delta for engagement when the layer has no activity event', () => {
    const noAct = { ...SOURCE, activityLayer: undefined }
    expect(analyzeRegime('*', pairsOf(fixture(10, 5, 5, false)), noAct, CERT_OK).engagement).toBe(1) // on made 4 vs 3 calls
    const same = fixture(10, 5, 5, false).map((r) => ({ ...r, llmCalls: 3 }))
    expect(analyzeRegime('*', pairsOf(same), noAct, CERT_OK).state).toBe('UNTESTED')
  })
  it('uses the layer\'s own target metric, not success, where the spec has one', () => {
    const src: LayerSource = { feature: 'f', mechanism: 'injection_detection', onArm: 'flagOn', offArm: 'off' }
    const runs: LayerRun[] = []
    for (let t = 0; t < 6; t++) {
      runs.push(run(`t${t}`, 'off', 1, { unauthorizedEffect: true, success: true }))
      runs.push(run(`t${t}`, 'flagOn', 1, { unauthorizedEffect: false, success: true, llmCalls: 5 }))
    }
    const r = analyzeRegime('*', pairsOf(runs), src, undefined)
    expect(r.targetDelta.mean).toBe(1) // unauthorized effect gone
    expect(r.successDelta.mean).toBe(0)
    expect(r.state).toBe('INCONCLUSIVE-UNDERPOWERED')
  })
})

describe('buildLayerValueMap', () => {
  const specs = new Map(MECHANISM_IDS.map((m) => [m, { hypothesisedRegime: `hyp-${m}`, targetMetric: `tm-${m}` }]))
  const input = (certs: Record<string, ProbeCertificate | undefined>) => ({
    runsByFeature: new Map([['f', fixture(10, 5, 5)]]),
    certificates: certs,
    specs,
    sources: [SOURCE],
  })
  it('gives every layer an entry and a hypothesised regime; unmeasured layers are UNTESTED', () => {
    const map = buildLayerValueMap(input({}))
    expect(map.layers.map((l) => l.mechanism)).toEqual([...MECHANISM_IDS])
    for (const l of map.layers) expect(l.hypothesisedRegime).not.toBe('')
    expect(map.layers.find((l) => l.mechanism === 'tool_policy')).toMatchObject({ overallState: 'UNTESTED', regimes: [] })
    expect(map.triggers.find((t) => t.mechanism === 'tool_policy')).toMatchObject({ basis: 'untested-hypothesis', regime: 'hyp-tool_policy' })
  })
  it('tolerates a missing certificate: never HELPS/NULL, empty priority order', () => {
    const map = buildLayerValueMap(input({}))
    const l = map.layers.find((x) => x.mechanism === 'semantic_contradiction')!
    expect(l.certificate).toBe('missing')
    expect(l.regimes.every((r) => r.state === 'INCONCLUSIVE-UNDERPOWERED' || r.state === 'UNTESTED')).toBe(true)
    expect(map.priority).toEqual([])
  })
  it('with a certificate the layer HELPS and enters the priority order', () => {
    const map = buildLayerValueMap(input({ semantic_contradiction: CERT_OK }))
    expect(map.layers.find((x) => x.mechanism === 'semantic_contradiction')!.overallState).toBe('HELPS-IN-REGIME')
    expect(map.priority[0]).toMatchObject({ mechanism: 'semantic_contradiction', regime: '*' })
    expect(map.priority[0].gainPerExtraCall).toBeCloseTo(0.5)
    expect(map.triggers).toContainEqual({ mechanism: 'semantic_contradiction', regime: '*', basis: 'measured-helps' })
  })
  it('a failed certificate keeps the layer inconclusive', () => {
    const map = buildLayerValueMap(input({ semantic_contradiction: CERT_BAD }))
    expect(map.layers.find((x) => x.mechanism === 'semantic_contradiction')!.overallState).toBe('INCONCLUSIVE-UNDERPOWERED')
  })
  it('is idempotent: same input → byte-identical JSON and markdown', () => {
    const a = buildLayerValueMap(input({ semantic_contradiction: CERT_OK }))
    const b = buildLayerValueMap(input({ semantic_contradiction: CERT_OK }))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(renderLayerValueMarkdown(a)).toBe(renderLayerValueMarkdown(b))
  })
  it('records the injection detector as UNTESTED at 0% engagement without attributing the audit drop to it', () => {
    const src: LayerSource = { feature: 'inj', mechanism: 'injection_detection', onArm: 'flagOn', offArm: 'off' }
    const runs: LayerRun[] = []
    for (let t = 0; t < 5; t++) for (let s = 1; s <= 3; s++) {
      runs.push(run(`t${t}`, 'off', s, { feature: 'inj', success: true, unauthorizedEffect: false }))
      runs.push(run(`t${t}`, 'flagOn', s, { feature: 'inj', success: t > 0, unauthorizedEffect: false }))
    }
    const map = buildLayerValueMap({ runsByFeature: new Map([['inj', runs]]), certificates: {}, specs, sources: [src] })
    const l = map.layers.find((x) => x.mechanism === 'injection_detection')!
    expect(l.overallState).toBe('UNTESTED')
    expect(l.regimes[0].engagement).toBe(0)
    expect(l.note).toMatch(/NOT attributed/)
  })
})

describe('runFromTranscript / parseLayerSpecs', () => {
  it('joins riskLevel, turn shape, fired layers and grade fields', () => {
    const r = runFromTranscript('f', {
      task: 't', arm: 'a', seed: 2,
      events: [
        { kind: 'llm_request' },
        { kind: 'trace', detail: { kind: 'risk_classified', riskLevel: 'HIGH' } },
        { kind: 'trace', detail: { kind: 'turn_boundary' } },
        { kind: 'trace', detail: { kind: 'layer_activity', layer: 'supervisor', fired: true } },
        { kind: 'trace', detail: { kind: 'layer_activity', layer: 'recovery', fired: false } },
      ],
      grade: { success: true, recovered: true, unauthorizedEffect: false },
      metrics: { costUsd: 0.5, latencyMs: 9 },
    }, new Map())
    expect(r).toMatchObject({ riskLevel: 'HIGH', turnShape: 'multi', firedLayers: ['supervisor'], llmCalls: 1, recovered: true, unauthorizedEffect: false, hallucination: null, costUsd: 0.5, category: 'unknown' })
  })
  it('parses hypothesised regime and target metric per section', () => {
    const m = parseLayerSpecs('# x\n\n## a\n\n- **Class:** floor\n- **Hypothesised regime:** when X\n- **Target metric:** rate Y\n\n## b\n\n- **Hypothesised regime:** Z\n')
    expect(m.get('a')).toEqual({ hypothesisedRegime: 'when X', targetMetric: 'rate Y' })
    expect(m.get('b')).toEqual({ hypothesisedRegime: 'Z', targetMetric: '' })
  })
})
