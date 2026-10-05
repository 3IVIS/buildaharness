import { describe, expect, it } from 'vitest'
import { normalizePlanNodes } from './normalize.js'
import { MALFORMED_PLANS, checkNormalized, normalizePlan, randomPlan, rng } from './testkit/generators.js'
import type { VizNode } from './types.js'
import { VIZ_STATUSES } from './types.js'

function garbagePlan(seed: number): VizNode[] {
  const r = rng(seed)
  const n = Math.floor(r() * 25)
  const ids = Array.from({ length: n }, (_, i) => `G${Math.floor(r() * (n + 2))}_${i % 5}`)
  return ids.map((id) => ({
    id,
    label: 'x',
    status: VIZ_STATUSES[Math.floor(r() * VIZ_STATUSES.length)],
    deps: Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.2 ? 'ghost' : ids[Math.floor(r() * Math.max(1, ids.length))] ?? 'ghost')),
  }))
}

describe('normalizePlanNodes', () => {
  for (const [name, plan] of Object.entries(MALFORMED_PLANS)) {
    it(`repairs malformed plan: ${name}`, () => {
      const out = normalizePlanNodes(plan)
      expect(checkNormalized(out.nodes)).toEqual([])
    })
  }

  it('satisfies checkNormalized and matches the executable spec on 2,000 seeded garbage plans', () => {
    for (let seed = 0; seed < 2000; seed++) {
      const plan = garbagePlan(seed)
      const out = normalizePlanNodes(plan)
      expect(checkNormalized(out.nodes), `seed ${seed}`).toEqual([])
      expect(out).toEqual(normalizePlan(plan))
    }
  })

  it('is identical to the spec on well-formed random plans and leaves them unrepaired', () => {
    for (let seed = 0; seed < 100; seed++) {
      const plan = randomPlan(seed)
      const out = normalizePlanNodes(plan)
      expect(out).toEqual(normalizePlan(plan))
      expect(out.warnings).toEqual([])
    }
  })

  it('does not mutate its input and survives a 100,000-deep chain', () => {
    const plan: VizNode[] = [{ id: 'A', label: 'A', status: 'pending', deps: ['B', 'B'] }, { id: 'B', label: 'B', status: 'pending', deps: ['A'] }]
    const copy = JSON.parse(JSON.stringify(plan))
    normalizePlanNodes(plan)
    expect(plan).toEqual(copy)
    const deep = Array.from({ length: 100000 }, (_, i): VizNode => ({ id: `D${i}`, label: 'd', status: 'pending', deps: i ? [`D${i - 1}`] : [] }))
    expect(checkNormalized(normalizePlanNodes(deep).nodes)).toEqual([])
  })

  it('reports what it repaired', () => {
    expect(normalizePlanNodes(MALFORMED_PLANS.twoCycle).warnings).toHaveLength(1)
    expect(normalizePlanNodes(MALFORMED_PLANS.duplicateIds).warnings).toEqual(['duplicate id A'])
  })
})
