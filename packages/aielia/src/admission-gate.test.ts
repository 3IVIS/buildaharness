import { describe, it, expect } from 'vitest'
import { admit, quantise, confidenceTerm, type ArmRecord, type PartitionInput, type GateInput } from './admission-gate.js'
import { describeEvidence, fixBreakList } from './suggestion-evidence.js'
import { SuggestionArchive } from './suggestion-archive.js'

const V = { model: 'm1', decoding: 't0', judge: 'j1' }
function arm(scores: number[], cost = 1, versions = V, prefix = 't'): ArmRecord {
  const results: Record<string, number[]> = {}
  scores.forEach((s, i) => { results[`${prefix}${i}`] = [s] })
  return { results, cost, versions }
}
/** n tasks; the incumbent passes `inc` of them, the candidate `cand`, the candidate's passes a superset prefix. */
function scores(n: number, passes: number): number[] {
  return Array.from({ length: n }, (_, i) => (i < passes ? 1 : 0))
}
function part(name: string, n: number, inc: number, cand: number, o: Partial<PartitionInput> = {}): PartitionInput {
  return { name, incumbent: arm(scores(n, inc)), candidate: arm(scores(n, cand)), beaconFired: true, proposerSaw: false, ...o }
}
const good = (over: Partial<GateInput> = {}): GateInput => ({
  partitions: [part('validation', 30, 12, 18)],
  turnsLayerOn: false,
  bestRecordedScore: 0.4,
  ...over,
})

describe('admit', () => {
  it('accepts a clean paired gain on an unseen partition and labels it screen', () => {
    const r = admit(good())
    expect(r.accepted).toBe(true)
    expect(r.label).toBe('screen')
    expect(r.reasons).toEqual([])
    expect(r.decidingPartition).toBe('validation')
  })

  it('rejects a gain that exists only on a partition the proposer saw', () => {
    const r = admit(good({ partitions: [part('train', 30, 12, 24, { proposerSaw: true })] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons.map((x) => x.code)).toContain('no_unseen_partition')
  })

  it('does not let a seen-partition gain stand in for a flat unseen one', () => {
    const r = admit(good({ partitions: [part('train', 30, 12, 26, { proposerSaw: true }), part('validation', 30, 12, 12)] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons.map((x) => x.code)).toContain('gain_below_deadband')
  })

  it('rejects mismatched task id sets', () => {
    const p = part('validation', 30, 12, 18)
    p.candidate = arm(scores(30, 18), 1, V, 'other')
    const r = admit(good({ partitions: [p] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons[0].code).toBe('task_ids_differ')
  })

  it('rejects mismatched version records', () => {
    const p = part('validation', 30, 12, 18)
    p.candidate = arm(scores(30, 18), 1, { ...V, judge: 'j2' })
    const r = admit(good({ partitions: [p] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons[0].code).toBe('versions_differ')
  })

  it('rejects a gain below the deadband', () => {
    const r = admit(good({ partitions: [part('validation', 100, 50, 52)] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons.map((x) => x.code)).toContain('gain_below_deadband')
  })

  it('rejects a gain that does not beat the best recorded score by the step', () => {
    const r = admit(good({ bestRecordedScore: 0.6 }))
    expect(r.accepted).toBe(false)
    expect(r.reasons.map((x) => x.code)).toEqual(['not_beating_best_recorded'])
    expect(admit(good({ bestRecordedScore: 0.56 })).accepted).toBe(true)
  })

  it('rejects when any partition regressed beyond the deadband', () => {
    const r = admit(good({ partitions: [part('validation', 30, 12, 18), part('sealed', 30, 20, 14)] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons.find((x) => x.code === 'partition_regressed')?.partition).toBe('sealed')
  })

  it('rejects a cost rise without a quality gain that pays for it, and accepts a paid one', () => {
    const rich = (cost: number, cand: number): GateInput => {
      const p = part('validation', 30, 12, cand)
      p.candidate = { ...p.candidate, cost }
      return good({ partitions: [p] })
    }
    expect(admit(rich(3, 18)).reasons.map((x) => x.code)).toContain('cost_without_gain')
    expect(admit(rich(1.05, 18)).accepted).toBe(true)
    expect(admit(rich(2, 30)).accepted).toBe(true)
  })

  it('rejects a layer turned on whose beacon never fired', () => {
    const r = admit(good({ turnsLayerOn: true, partitions: [part('validation', 30, 12, 18, { beaconFired: false })] }))
    expect(r.accepted).toBe(false)
    expect(r.reasons.map((x) => x.code)).toEqual(['beacon_not_fired'])
    expect(admit(good({ turnsLayerOn: true })).accepted).toBe(true)
  })

  it('rejects missing, empty and malformed input', () => {
    expect(admit(good({ partitions: [] })).reasons[0].code).toBe('empty_input')
    const empty = part('validation', 30, 12, 18)
    empty.incumbent = { ...empty.incumbent, results: {} }
    expect(admit(good({ partitions: [empty] })).reasons[0].code).toBe('empty_input')
    const bad = part('validation', 30, 12, 18)
    bad.candidate.results.t0 = [2]
    expect(admit(good({ partitions: [bad] })).reasons[0].code).toBe('malformed_scores')
    expect(admit({ partitions: undefined as never, turnsLayerOn: false, bestRecordedScore: 0 }).accepted).toBe(false)
  })

  it('certificate is impossible at 30 tasks, even for a perfect candidate', () => {
    const r = admit(good({ partitions: [part('validation', 30, 0, 30)], bestRecordedScore: 0 }))
    expect(r.accepted).toBe(true)
    expect(r.label).toBe('screen')
    expect(r.confidenceTerm!).toBeGreaterThan(0.5)
  })

  it('certificate is possible with a large synthetic set, and only then', () => {
    const big = admit(good({ partitions: [part('validation', 1300, 300, 1100)], bestRecordedScore: 0 }))
    expect(big.confidenceTerm!).toBeLessThanOrEqual(0.1)
    expect(big.label).toBe('certificate')
    // large set but a gain too small to clear the confidence term: accepted as a screen
    const small = admit(good({ partitions: [part('validation', 1300, 600, 700)], bestRecordedScore: 0 }))
    expect(small.accepted).toBe(true)
    expect(small.label).toBe('screen')
  })

  it('reports Wilson bounds for display', () => {
    const s = admit(good()).partitions[0]
    expect(s.candidateWilson).toBeGreaterThan(s.incumbentWilson)
    expect(s.candidateWilson).toBeLessThan(s.candidateMean)
  })
})

describe('helpers', () => {
  it('quantises down to the step', () => {
    expect(quantise(0.61, 0.02)).toBeCloseTo(0.6)
    expect(quantise(0.6, 0.02)).toBeCloseTo(0.6)
    expect(confidenceTerm(0, { candidatesTimesRounds: 20, delta: 0.05 })).toBe(Infinity)
  })
})

describe('suggestion evidence', () => {
  it('shows absent fields as missing', () => {
    const lines = describeEvidence({ selection: { admission: ['validation'] }, activation: { loadRate: 1 } })
    const get = (f: string) => lines.find((l) => l.field === f)!.value
    expect(get('admission')).toBe('validation')
    expect(get('loadRate')).toBe('1')
    expect(get('proposal')).toBe('missing')
    expect(get('carryRate')).toBe('missing')
    expect(describeEvidence(undefined).every((l) => l.value === 'missing')).toBe(true)
  })

  it('lists the tasks fixed and broken', () => {
    const p = part('validation', 4, 0, 0)
    p.incumbent = arm([1, 0, 1, 0]); p.candidate = arm([0, 1, 1, 0])
    expect(fixBreakList([p])).toEqual({ fixed: ['validation/t1'], broken: ['validation/t0'] })
  })
})

describe('SuggestionArchive', () => {
  const entry = (id: string, at: number, parentId?: string) => ({ suggestionId: id, parentId, fingerprint: 'f' + id, cell: 'layer.x', decision: 'proposed', reason: 'r', at })

  it('is append-only: list returns copies and seq is monotonic', () => {
    const a = new SuggestionArchive()
    a.append(entry('a', 1)); a.append(entry('b', 2))
    const l = a.list()
    l[0].decision = 'tampered'
    expect(a.list()[0].decision).toBe('proposed')
    expect(a.list().map((e) => e.seq)).toEqual([1, 2])
  })

  it('follows lineage from the root', () => {
    const a = new SuggestionArchive()
    a.append(entry('a', 1)); a.append(entry('b', 2, 'a')); a.append(entry('c', 3, 'b')); a.append(entry('z', 4))
    expect(a.lineage('c').map((e) => e.suggestionId)).toEqual(['a', 'b', 'c'])
    expect(a.byCell('layer.x')).toHaveLength(4)
  })

  it('tracks the best recorded score from accepted gate results and never lowers it', () => {
    const a = new SuggestionArchive()
    const r = admit(good())
    a.append({ ...entry('a', 1), gate: r })
    expect(a.bestRecordedScore()).toBeCloseTo(r.quantisedScore!)
    a.recordBestScore(0.1)
    expect(a.bestRecordedScore()).toBeCloseTo(r.quantisedScore!)
    a.append({ ...entry('b', 2), gate: { ...admit(good({ partitions: [part('v', 30, 12, 12)] })) } })
    expect(a.bestRecordedScore()).toBeCloseTo(r.quantisedScore!)
  })

  it('prunes by retention window and cap but keeps the best score', () => {
    const a = new SuggestionArchive({ retentionMs: 100, maxEntries: 2 })
    a.recordBestScore(0.7)
    a.append(entry('old', 0)); a.append(entry('x', 950)); a.append(entry('y', 960)); a.append(entry('z', 970))
    expect(a.prune(1000)).toBe(2)
    expect(a.list().map((e) => e.suggestionId)).toEqual(['y', 'z'])
    expect(a.bestRecordedScore()).toBe(0.7)
  })

  it('round-trips through JSON and degrades to empty on garbage', () => {
    const a = new SuggestionArchive()
    a.append(entry('a', 1)); a.recordBestScore(0.5)
    const b = SuggestionArchive.fromJSON(JSON.parse(JSON.stringify(a.toJSON())))
    expect(b.list()).toEqual(a.list())
    expect(b.bestRecordedScore()).toBe(0.5)
    expect(b.append(entry('n', 2)).seq).toBe(2)
    expect(SuggestionArchive.fromJSON('nope').list()).toEqual([])
    expect(SuggestionArchive.fromJSON({ entries: [1, { suggestionId: 3 }] }).list()).toEqual([])
  })
})
