import { describe, expect, it } from 'vitest'
import { NAMED_PLANS, NINE_TASK_PLAN, randomPlan, rng, templatePlans } from './testkit/generators.js'
import { checkBoundaries, checkHorizontal, checkReachability, checkRepeatCycles, checkTabCycle, navModelFrom as kitModelFrom, referenceNavigator } from './testkit/nav-oracles.js'
import { renderPlan } from './plan-raster.js'
import { navModelFrom, planNavigator, type NavKey } from './plan-nav.js'
import type { VizNode } from './types.js'

const KEYS: NavKey[] = ['up', 'down', 'left', 'right', 'tab', 'shiftTab']

function modelOf(nodes: VizNode[]) {
  const r = renderPlan(nodes, { maxCols: 120 })
  if (!r.ok) return undefined
  return { model: navModelFrom(nodes, r.boxes), kit: kitModelFrom(nodes, r.boxes) }
}

const fixtures: Array<[string, VizNode[]]> = [
  ['nine', NINE_TASK_PLAN],
  ...Object.entries(NAMED_PLANS).map(([k, v]) => [`named-${k}`, v.nodes] as [string, VizNode[]]),
  ...Object.entries(templatePlans()).map(([k, v]) => [`template-${k}`, v] as [string, VizNode[]]),
]

describe('planNavigator', () => {
  it('builds the same model as the kit', () => {
    for (const [name, nodes] of fixtures) {
      const m = modelOf(nodes)
      if (!m) continue
      expect(m.model, name).toEqual(m.kit)
    }
  })

  it('passes every navigation oracle on every fixture', () => {
    for (const [name, nodes] of fixtures) {
      const m = modelOf(nodes)
      if (!m || !m.model.ids.length) continue
      const problems = [
        ...checkBoundaries(planNavigator, m.model), ...checkHorizontal(planNavigator, m.model), ...checkRepeatCycles(planNavigator, m.model), ...checkTabCycle(planNavigator, m.model),
      ]
      expect(problems, name).toEqual([])
    }
  })

  it('reaches every node of a connected plan with arrow keys', () => {
    for (const [name, { nodes, connected }] of Object.entries(NAMED_PLANS)) {
      const m = modelOf(nodes)
      if (!m || !connected || !m.model.ids.length) continue
      expect(checkReachability(planNavigator, m.model), name).toEqual([])
    }
  })

  it('selects the same node as the reference navigator at every step (differential, seeded random key sequences)', () => {
    const plans: Array<[string, VizNode[]]> = [...fixtures]
    for (let seed = 1; seed <= 150; seed++) plans.push([`random-${seed}`, randomPlan(seed, {})])
    let steps = 0
    for (const [name, nodes] of plans) {
      const m = modelOf(nodes)
      if (!m || !m.model.ids.length) continue
      const next = rng(nodes.length * 7919 + 13)
      for (let run = 0; run < 8; run++) {
        const start = m.model.ids[Math.floor(next() * m.model.ids.length)]
        let a = planNavigator.start(m.model, start)
        let b = referenceNavigator.start(m.kit, start)
        for (let i = 0; i < 40; i++) {
          const key = KEYS[Math.floor(next() * KEYS.length)]
          a = planNavigator.press(m.model, a, key)
          b = referenceNavigator.press(m.kit, b, key)
          steps++
          expect(a, `${name} run ${run} step ${i} (${key})`).toEqual(b)
        }
      }
    }
    expect(steps).toBeGreaterThan(10_000)
  })
})

describe('repeated vertical keys on a chain', () => {
  // The site plan's shape: a single dependent at each step must be walkable with ↓ alone (and back up with ↑ alone).
  const chain: VizNode[] = [
    { id: 'a', label: 'a', status: 'pending', deps: [] },
    { id: 'b', label: 'b', status: 'pending', deps: ['a'] },
    { id: 'c', label: 'c', status: 'pending', deps: ['b'] },
    { id: 'd', label: 'd', status: 'pending', deps: ['c'] },
  ]

  it('keeps moving down, then up, when every node has one dependent', () => {
    const m = modelOf(chain)!
    for (const nav of [planNavigator, referenceNavigator] as const) {
      const model = nav === planNavigator ? m.model : m.kit
      let s = nav.start(model, 'a')
      const down: string[] = []
      for (let i = 0; i < 3; i++) { s = nav.press(model, s, 'down'); down.push(s.cur) }
      expect(down).toEqual(['b', 'c', 'd'])
      const up: string[] = []
      for (let i = 0; i < 3; i++) { s = nav.press(model, s, 'up'); up.push(s.cur) }
      expect(up).toEqual(['c', 'b', 'a'])
    }
  })
})
