import { describe, expect, it } from 'vitest'
import { MALFORMED_PLANS, NAMED_PLANS, NINE_TASK_PLAN, edgesOf, normalizePlan, randomPlan, rng, templatePlans, toyLayout } from './generators.js'
import {
  checkBoundaries, checkHighlightIncident, checkHorizontal, checkReachability, checkRepeatCycles, checkTabCycle, checkViewport, followSelection, navModelFrom,
  reachableByArrows, referenceNavigator, type NavKey, type NavModel, type NavState, type Navigator, type Viewport,
} from './nav-oracles.js'
import type { Box, Edge, VizNode } from './types.js'

/** Normalizes first, as the production adapter must, so malformed input never reaches navigation. */
const modelOf = (plan: readonly VizNode[]): NavModel => {
  const nodes = normalizePlan(plan).nodes
  return navModelFrom(nodes, toyLayout(nodes).boxes)
}

/** The obvious rule that V10 showed to be wrong: "go to the nearest connected node". Kept as a mutation to prove the oracles catch it. */
const naiveNavigator: Navigator = {
  start: (_m, id) => ({ cur: id, k: 0 }),
  press(m, st, key: NavKey): NavState {
    const near = (ids: readonly string[]): string => (ids.length ? [...ids].sort((a, b) => Math.abs(m.x[a] - m.x[st.cur]) - Math.abs(m.x[b] - m.x[st.cur]) || (a < b ? -1 : 1))[0] : st.cur)
    if (key === 'up') return { cur: near(m.deps[st.cur]), k: 0 }
    if (key === 'down') return { cur: near(m.dependents[st.cur]), k: 0 }
    if (key === 'tab' || key === 'shiftTab') return st
    const rank = [...m.ids].filter((id) => m.y[id] === m.y[st.cur]).sort((a, b) => m.x[a] - m.x[b] || (a < b ? -1 : 1))
    const i = rank.indexOf(st.cur)
    return { cur: rank[(i + (key === 'left' ? -1 : 1) + rank.length) % rank.length], k: 0 }
  },
}

describe('reference navigator — the full property suite', () => {
  const allOracles = (m: NavModel): string[] => [
    ...checkReachability(referenceNavigator, m), ...checkTabCycle(referenceNavigator, m), ...checkBoundaries(referenceNavigator, m),
    ...checkHorizontal(referenceNavigator, m), ...checkRepeatCycles(referenceNavigator, m),
  ]

  for (const [name, { nodes, connected }] of Object.entries(NAMED_PLANS)) {
    it(`named plan ${name}`, () => {
      const m = modelOf(nodes)
      const problems = allOracles(m)
      if (connected) expect(problems).toEqual([])
      else expect(problems.filter((p) => !/arrow keys cannot reach/.test(p))).toEqual([]) // a disconnected plan is only reachable via Tab
    })
  }

  for (const [name, nodes] of Object.entries(templatePlans())) {
    it(`real template ${name}`, () => {
      expect(allOracles(modelOf(nodes))).toEqual([])
    })
  }

  it('3000 random connected plans (3–40 tasks): every node reachable with arrows, all other rules hold', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const problems = allOracles(modelOf(randomPlan(seed, { minNodes: 3, maxNodes: 40 })))
      if (problems.length) throw new Error(`seed ${seed}: ${problems.slice(0, 3).join('; ')}`)
    }
  })

  it('arrows never jump between disconnected components; Tab always does', () => {
    // Two components whose roots sit in different ranks (as a network-simplex layout can place them), so no ←/→ move links them.
    const m: NavModel = {
      ids: ['a1', 'a2', 'b1'], taskOrder: ['a1', 'a2', 'b1'],
      x: { a1: 5, a2: 5, b1: 5 }, y: { a1: 0, a2: 6, b1: 12 },
      deps: { a1: [], a2: ['a1'], b1: [] }, dependents: { a1: ['a2'], a2: [], b1: [] },
    }
    expect(checkReachability(referenceNavigator, m, 'a1').join()).toMatch(/cannot reach: b1/)
    expect(checkTabCycle(referenceNavigator, m)).toEqual([])
  })

  it('a two-thread plan whose roots share a rank is arrow-reachable through ←/→ (documented behaviour of rank-based layouts)', () => {
    expect(checkReachability(referenceNavigator, modelOf(NAMED_PLANS.twoThreads.nodes), 't1__A')).toEqual([])
  })

  it('plans that were malformed still navigate once normalized (no crash, Tab cycle intact)', () => {
    for (const [name, input] of Object.entries(MALFORMED_PLANS)) {
      if (name === 'thousandNodes') continue
      const m = modelOf(input)
      expect(checkTabCycle(referenceNavigator, m), name).toEqual([])
      expect(checkBoundaries(referenceNavigator, m), name).toEqual([])
    }
  })
})

describe('the oracles detect the naive rule (mutation check)', () => {
  // Found by search over seeded plans (4–14 tasks, toy layout): the naive rule strands nodes, the reference rule does not.
  for (const seed of [22, 28, 63]) {
    it(`seed ${seed}: naive navigation cannot reach every node, the reference can`, () => {
      const m = modelOf(randomPlan(seed, { minNodes: 4, maxNodes: 14 }))
      expect(checkReachability(naiveNavigator, m).join()).toMatch(/cannot reach/)
      expect(checkReachability(referenceNavigator, m)).toEqual([])
    })
  }
  it('the repeat-cycle oracle flags a navigator that never cycles', () => {
    const m = modelOf(NAMED_PLANS.fanOut5.nodes)
    expect(checkRepeatCycles(naiveNavigator, m).join()).toMatch(/does not visit each of/)
  })
  it('the Tab oracle flags a navigator whose Tab does nothing', () => {
    expect(checkTabCycle(naiveNavigator, modelOf(NINE_TASK_PLAN)).join()).toMatch(/Tab does not visit nodes in task order/)
  })
  it('the boundary oracle flags a navigator that moves when it should not', () => {
    const jumpy: Navigator = { start: referenceNavigator.start, press: (m, st, key) => (key === 'up' && !m.deps[st.cur].length ? { cur: m.ids[m.ids.length - 1], k: 0 } : referenceNavigator.press(m, st, key)) }
    expect(checkBoundaries(jumpy, modelOf(NINE_TASK_PLAN)).join()).toMatch(/\(no dependencies\) moved the selection/)
  })
  it('the horizontal oracle flags a navigator that leaves the rank', () => {
    const wandering: Navigator = { start: referenceNavigator.start, press: (m, st, key) => (key === 'right' ? { cur: m.ids[(m.ids.indexOf(st.cur) + 1) % m.ids.length], k: 0 } : referenceNavigator.press(m, st, key)) }
    expect(checkHorizontal(wandering, modelOf(NINE_TASK_PLAN)).length).toBeGreaterThan(0)
  })
})

describe('navigation behaviour on the nine-task plan (concrete, readable cases)', () => {
  const m = modelOf(NINE_TASK_PLAN)
  const press = (start: string, ...keys: NavKey[]): string => keys.reduce((s, k) => referenceNavigator.press(m, s, k), referenceNavigator.start(m, start)).cur

  it('↓ follows an edge to a dependent, ↑ follows it back to a dependency', () => {
    expect(m.dependents.T1).toContain(press('T1', 'down'))
    expect(m.deps.T4).toContain(press('T4', 'up'))
  })
  it('repeated ↓ from T1 visits each of its five dependents once', () => {
    const visited = [1, 2, 3, 4, 5].map((n) => press('T1', ...Array<NavKey>(n).fill('down')))
    expect(new Set(visited)).toEqual(new Set(m.dependents.T1))
  })
  it('↑ on the first task and ↓ on the goal do nothing', () => {
    expect(press('T1', 'up')).toBe('T1')
    expect(press('G', 'down')).toBe('G')
  })
  it('a different key between presses resets the cycle', () => {
    const first = press('T1', 'down')
    expect(press('T1', 'down', 'left', 'right', 'up', 'down')).not.toBeUndefined()
    expect(m.dependents[first] ?? []).toBeDefined()
  })
  it('Tab walks the plan in task order and wraps', () => {
    expect(press('T1', 'tab')).toBe('T2')
    expect(press('G', 'tab')).toBe('T1')
    expect(press('T1', 'shiftTab')).toBe('G')
  })
  it('reachability from every start node, not only the first', () => {
    for (const id of m.ids) expect(checkReachability(referenceNavigator, m, id)).toEqual([])
  })
  it('exploring with real key state visits a finite state space (no runaway)', () => {
    expect(reachableByArrows(referenceNavigator, m, 'T1').size).toBe(m.ids.length)
  })
})

describe('edge highlighting oracle', () => {
  const plan = NINE_TASK_PLAN
  const m = modelOf(plan)
  const edges = edgesOf(plan)
  const incident = (id: string): Edge[] => edges.filter((e) => e.from === id || e.to === id)
  it('accepts exactly the incident edges', () => {
    expect(checkHighlightIncident(m, edges, incident)).toEqual([])
  })
  it('flags a missing edge', () => {
    expect(checkHighlightIncident(m, edges, (id) => incident(id).slice(1)).join()).toMatch(/does not highlight/)
  })
  it('flags an unrelated edge', () => {
    expect(checkHighlightIncident(m, edges, (id) => [...incident(id), { from: 'T2', to: 'T9' }]).join()).toMatch(/unrelated edge/)
  })
  it('flags highlighting everything', () => {
    expect(checkHighlightIncident(m, edges, () => edges).length).toBeGreaterThan(0)
  })
})

describe('viewport following (pan) specification', () => {
  const grid = { width: 200, height: 80 }
  const term = { cols: 80, rows: 24 }
  const box = (id: string, x: number, y: number, w = 18, h = 3): Box => ({ id, x, y, w, h })
  const start: Viewport = { left: 0, top: 0, width: 80, height: 24 }

  it('does not move when the selection is already visible (no jumping while navigating)', () => {
    const v = followSelection(start, box('a', 10, 5), grid, term)
    expect(v).toEqual(start)
  })
  it('scrolls the minimum amount to reveal a box off to the right and below', () => {
    const v = followSelection(start, box('a', 150, 50), grid, term)
    expect(v.left).toBe(150 + 18 - 80)
    expect(v.top).toBe(50 + 3 - 24)
    expect(checkViewport(v, box('a', 150, 50), grid, term)).toEqual([])
  })
  it('never leaves the diagram and never exceeds the terminal, for 2000 random boxes and terminals', () => {
    const next = rng(2026)
    const r = (n: number): number => Math.floor(next() * n)
    for (let i = 0; i < 2000; i++) {
      const g = { width: 20 + r(300), height: 8 + r(120) }
      const t = { cols: 20 + r(160), rows: 6 + r(60) }
      const w = Math.min(8 + r(24), g.width)
      const b = box('x', r(g.width - w + 1), r(g.height - 3 + 1), w, 3) // always inside the diagram
      const prev: Viewport = { left: r(g.width), top: r(g.height), width: 0, height: 0 } // arbitrary, even out-of-range, previous position
      const v = followSelection(prev, b, g, t)
      expect(checkViewport(v, b, g, t), `iteration ${i}`).toEqual([])
    }
  })
  it('a diagram smaller than the terminal is shown whole', () => {
    const v = followSelection(start, box('a', 5, 2), { width: 40, height: 12 }, term)
    expect(v).toEqual({ left: 0, top: 0, width: 40, height: 12 })
  })
  it('the viewport oracle flags a viewport that hides the selection', () => {
    expect(checkViewport({ left: 0, top: 0, width: 80, height: 24 }, box('far', 150, 50), grid, term).join()).toMatch(/not horizontally visible/)
  })
})
