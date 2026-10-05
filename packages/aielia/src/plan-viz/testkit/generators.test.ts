import { describe, expect, it } from 'vitest'
import { checkNoOverlap, checkRanksDownward } from './grid-oracles.js'
import {
  MALFORMED_PLANS, NAMED_PLANS, NINE_TASK_PLAN, checkNormalized, edgesOf, isAcyclic, isConnected, normalizePlan, randomPlan, ranksOf, rng, templatePlans, toyLayout, withGoal, withStatus,
} from './generators.js'
import { VIZ_STATUSES } from './types.js'

describe('seeded generators', () => {
  it('rng is deterministic per seed and differs across seeds', () => {
    const a = rng(42), b = rng(42), c = rng(43)
    const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()]
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true)
  })

  it('randomPlan is reproducible and respects size bounds', () => {
    expect(randomPlan(7)).toEqual(randomPlan(7))
    for (let seed = 1; seed <= 200; seed++) {
      const plan = randomPlan(seed, { minNodes: 3, maxNodes: 12 })
      expect(plan.length).toBeGreaterThanOrEqual(4) // 3..12 tasks plus the goal
      expect(plan.length).toBeLessThanOrEqual(13)
    }
  })

  it('randomPlan output is acyclic, normalized, and connected when a goal is added', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const plan = randomPlan(seed, { unicodeLabels: seed % 3 === 0 })
      expect(checkNormalized(plan)).toEqual([])
      expect(isAcyclic(plan)).toBe(true)
      expect(isConnected(plan)).toBe(true)
    }
  })

  it('randomPlan without a goal may be disconnected but is still acyclic and normalized', () => {
    let sawDisconnected = false
    for (let seed = 1; seed <= 300; seed++) {
      const plan = randomPlan(seed, { goal: false })
      expect(checkNormalized(plan)).toEqual([])
      if (!isConnected(plan)) sawDisconnected = true
    }
    expect(sawDisconnected).toBe(true)
  })

  it('uses every status across a large sample', () => {
    const seen = new Set(Array.from({ length: 100 }, (_, i) => randomPlan(i + 1)).flat().map((n) => n.status))
    for (const s of VIZ_STATUSES) expect(seen.has(s)).toBe(true)
  })
})

describe('named fixtures', () => {
  for (const [name, { nodes, connected }] of Object.entries(NAMED_PLANS)) {
    it(`${name}: normalized, acyclic, connectivity flag is truthful`, () => {
      expect(checkNormalized(nodes)).toEqual([])
      expect(isAcyclic(nodes)).toBe(true)
      expect(isConnected(nodes)).toBe(connected)
    })
  }

  it('the nine-task plan has the dependency structure the verification work used', () => {
    expect(edgesOf(NINE_TASK_PLAN)).toHaveLength(13)
    expect(ranksOf(NINE_TASK_PLAN).G).toBe(5)
  })

  it('covers the shapes that stress layout: wide fan-out, deep chain, unicode, long labels, every status', () => {
    expect(NAMED_PLANS.wide25.nodes.length).toBe(26)
    expect(NAMED_PLANS.deepChain30.nodes.length).toBe(31)
    expect(NAMED_PLANS.allStatuses.nodes.map((n) => n.status)).toEqual([...VIZ_STATUSES])
    expect(NAMED_PLANS.cjkLabels.nodes.some((n) => /[぀-鿿]/.test(n.label))).toBe(true)
    expect(Math.max(...NAMED_PLANS.longLabels.nodes.map((n) => n.label.length))).toBeGreaterThan(60)
  })
})

describe('real plan templates as fixtures', () => {
  const plans = templatePlans()
  it('includes all seven shipped templates', () => {
    expect(Object.keys(plans).sort()).toEqual(['contentCreation', 'decisionMaking', 'problemSolving', 'processImprovement', 'projectPlanning', 'researchAnalysis', 'tripPlanning'])
  })
  for (const [name, nodes] of Object.entries(plans)) {
    it(`${name}: valid, connected through its goal, and mixes statuses`, () => {
      expect(checkNormalized(nodes)).toEqual([])
      expect(isConnected(nodes)).toBe(true)
      expect(nodes[nodes.length - 1].id).toBe('goal')
      expect(new Set(nodes.map((n) => n.status)).size).toBeGreaterThanOrEqual(3)
    })
  }
})

describe('normalizePlan (the input contract the layout may rely on)', () => {
  for (const [name, input] of Object.entries(MALFORMED_PLANS)) {
    it(`${name}: normalized output satisfies the contract`, () => {
      expect(checkNormalized(normalizePlan(input).nodes)).toEqual([])
    })
  }

  it('reports what it repaired', () => {
    expect(normalizePlan(MALFORMED_PLANS.unknownDependency).warnings.join()).toMatch(/unknown dependency nope/)
    expect(normalizePlan(MALFORMED_PLANS.selfLoop).warnings.join()).toMatch(/self dependency/)
    expect(normalizePlan(MALFORMED_PLANS.twoCycle).warnings.join()).toMatch(/cycle broken/)
    expect(normalizePlan(MALFORMED_PLANS.duplicateIds).warnings.join()).toMatch(/duplicate id A/)
  })

  it('keeps the first of duplicate ids and de-duplicates repeated dependencies', () => {
    expect(normalizePlan(MALFORMED_PLANS.duplicateIds).nodes.find((n) => n.id === 'A')?.label).toBe('first')
    expect(normalizePlan(MALFORMED_PLANS.duplicateDeps).nodes.find((n) => n.id === 'B')?.deps).toEqual(['A'])
  })

  it('does not change an already valid plan', () => {
    for (const { nodes } of Object.values(NAMED_PLANS)) expect(normalizePlan(nodes)).toEqual({ nodes, warnings: [] })
  })

  it('is deterministic and handles a thousand nodes quickly', () => {
    const t0 = performance.now()
    const a = normalizePlan(MALFORMED_PLANS.thousandNodes)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(a).toEqual(normalizePlan(MALFORMED_PLANS.thousandNodes))
    expect(a.nodes).toHaveLength(1000)
  })
})

describe('helpers', () => {
  it('withGoal makes a goal depending on exactly the sinks', () => {
    const plan = withGoal([{ id: 'A', label: 'A', status: 'done', deps: [] }, { id: 'B', label: 'B', status: 'done', deps: ['A'] }, { id: 'C', label: 'C', status: 'done', deps: [] }])
    expect(plan.at(-1)).toMatchObject({ id: 'GOAL', deps: ['B', 'C'] })
  })
  it('withStatus changes one node only', () => {
    const next = withStatus(NINE_TASK_PLAN, 'T3', 'done')
    expect(next.find((n) => n.id === 'T3')?.status).toBe('done')
    expect(next.filter((n, i) => n.status !== NINE_TASK_PLAN[i].status)).toHaveLength(1)
  })
  it('toyLayout is itself a valid layout (so oracle self-tests can trust it)', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { boxes, edges } = toyLayout(randomPlan(seed))
      expect(checkNoOverlap(boxes)).toEqual([])
      expect(checkRanksDownward(boxes, edges)).toEqual([])
    }
  })
})
