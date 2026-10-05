import { describe, expect, it } from 'vitest'
import { checkRender } from './testkit/grid-oracles.js'
import { MALFORMED_PLANS, NAMED_PLANS, NINE_TASK_PLAN, randomPlan, templatePlans, withStatus } from './testkit/generators.js'
import { renderPlan, type PlanRender } from './plan-raster.js'
import { highlightCells, incidentEdges } from './plan-routes.js'
import { followSelection, scrollIndicators, type Viewport } from './plan-viewport.js'
import { checkHighlightIncident, checkViewport, navModelFrom } from './testkit/nav-oracles.js'
import { edgesOf } from './testkit/generators.js'
import type { VizNode } from './types.js'

// eslint-disable-next-line no-control-regex
const strip = (lines: string[]): string[] => lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))

function check(nodes: VizNode[], opts: Parameters<typeof renderPlan>[1] = {}): string[] {
  const r = renderPlan(nodes, opts)
  if (!r.ok) return [`cannot draw: ${r.message}`]
  const ascii = opts.ascii ?? false
  const clean = nodes.length ? r : r
  return checkRender({ render: { lines: strip(r.lines), boxes: r.boxes, edges: r.edges }, nodes, maxCols: r.fits ? opts.maxCols : undefined, labels: ascii ? undefined : r.labels, opts: { ascii } }).map((p) => `${p}\n${strip(clean.lines).join('\n')}`)
}

describe('renderPlan: oracle-clean for every fixture', () => {
  for (const [name, { nodes }] of Object.entries(NAMED_PLANS)) {
    it(`named plan ${name}`, () => {
      expect(check(nodes, { maxCols: 100 })).toEqual([])
      expect(check(nodes, { maxCols: 100, ascii: true })).toEqual([])
    })
  }
  for (const [name, nodes] of Object.entries(templatePlans())) {
    it(`template ${name}`, () => {
      expect(check(nodes, { maxCols: 120 })).toEqual([])
    })
  }
  for (const cols of [40, 60, 80, 100, 140, 200]) {
    for (const ascii of [false, true]) for (const color of [false, true]) {
      it(`nine-task plan at ${cols} columns (ascii=${ascii}, color=${color})`, () => {
        expect(check(NINE_TASK_PLAN, { maxCols: cols, ascii, color, selectedId: 'T3' })).toEqual([])
      })
    }
  }
  it('shows the nine-task plan within 100 columns', () => {
    const r = renderPlan(NINE_TASK_PLAN, { maxCols: 100 }) as PlanRender
    expect(r.fits).toBe(true)
    expect(r.width).toBeLessThanOrEqual(100)
  })
  it('CJK, emoji and very long labels', () => {
    const nodes: VizNode[] = [
      { id: 'A', label: '数据收集与分析的非常长的标题🚀🚀🚀', status: 'done', deps: [] },
      { id: 'B', label: 'x'.repeat(300), status: 'running', deps: ['A'] },
      { id: 'C', label: 'é́ combining', status: 'pending', deps: ['A'] },
    ]
    for (const maxCols of [40, 80]) expect(check(nodes, { maxCols })).toEqual([])
  })
})

describe('renderPlan: seeded random plans', () => {
  it('5,000 small plans, unicode and ASCII', () => {
    for (let seed = 1; seed <= 5000; seed++) {
      const nodes = randomPlan(seed, { maxNodes: 9, unicodeLabels: seed % 5 === 0 })
      const problems = check(nodes, { maxCols: 80 + (seed % 4) * 40, ascii: seed % 7 === 0 })
      if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`)
    }
  })
  it('150 larger plans', () => {
    for (let seed = 10_000; seed < 10_150; seed++) {
      const problems = check(randomPlan(seed, { minNodes: 15, maxNodes: 45 }), { maxCols: 120 })
      if (problems.length) throw new Error(`seed ${seed}: ${problems[0]}`)
    }
  })
})

describe('renderPlan: robustness', () => {
  for (const [name, nodes] of Object.entries(MALFORMED_PLANS)) {
    it(`malformed ${name} never throws`, () => {
      const r = renderPlan(nodes, { maxCols: 80 })
      if (r.ok) expect(check(nodes, { maxCols: 80 })).toEqual([])
      else expect(r.message.length).toBeGreaterThan(0)
    })
  }
  it('reports a plan over the node cap as too large', () => {
    const r = renderPlan(MALFORMED_PLANS.thousandNodes)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too_large')
  })
  it('strips control and bidi characters from labels', () => {
    const r = renderPlan([{ id: 'A', label: 'bell\u0007 ‮evil\u001b[31m red\nline', status: 'pending', deps: [] }]) as PlanRender
    expect(r.labels.A).not.toMatch(/[\u0000-\u001f‮]/)
    expect(check([{ id: 'A', label: 'bell\u0007 ‮evil', status: 'pending', deps: [] }])).toEqual([])
  })
})

describe('renderPlan: determinism and stability', () => {
  it('same input, same output', () => {
    expect(renderPlan(NINE_TASK_PLAN, { maxCols: 100 })).toEqual(renderPlan(NINE_TASK_PLAN, { maxCols: 100 }))
  })
  it('changing one status never moves a box', () => {
    const base = renderPlan(NINE_TASK_PLAN, { maxCols: 100 }) as PlanRender
    for (const n of NINE_TASK_PLAN) for (const status of ['done', 'failed', 'running', 'pending'] as const) {
      const r = renderPlan(withStatus(NINE_TASK_PLAN, n.id, status), { maxCols: 100 }) as PlanRender
      expect(r.boxes).toEqual(base.boxes)
    }
  })
  it('colour never changes geometry; NO colour output has no escape sequences', () => {
    const plain = renderPlan(NINE_TASK_PLAN, { maxCols: 100 }) as PlanRender
    const coloured = renderPlan(NINE_TASK_PLAN, { maxCols: 100, color: true, selectedId: 'T3' }) as PlanRender
    expect(coloured.boxes).toEqual(plain.boxes)
    expect(strip(coloured.lines)).toEqual(plain.lines)
    expect(plain.lines.join('')).not.toContain('\u001b')
  })
})

describe('renderPlan: budgets (measured 2026-10-05: 25 nodes about 100 ms, 150 nodes about 600 ms; budgets are 3x)', () => {
  it('25 nodes within 300 ms', () => {
    const nodes = randomPlan(7, { minNodes: 24, maxNodes: 24, density: 0.12 })
    renderPlan(nodes, { maxCols: 120 })
    const t = performance.now()
    renderPlan(nodes, { maxCols: 120 })
    expect(performance.now() - t).toBeLessThan(300)
  })
  it('150 nodes within 2 s', () => {
    const nodes = randomPlan(7, { minNodes: 149, maxNodes: 149, density: 0.01 })
    const t = performance.now()
    const r = renderPlan(nodes, { maxCols: 120 })
    expect(r.ok).toBe(true)
    expect(performance.now() - t).toBeLessThan(2000)
  })
  it('a dense plan over the edge cap falls back instead of exhausting memory', () => {
    const r = renderPlan(randomPlan(7, { minNodes: 149, maxNodes: 149, density: 0.12 }))
    expect(r.ok).toBe(false)
  })
})

describe('highlighting uses the real routes', () => {
  it('selecting a node highlights exactly its incident edges, and every route runs from its source box to its target box', () => {
    for (const nodes of [NINE_TASK_PLAN, ...[1, 2, 3, 4, 5, 6, 7, 8].map((s) => randomPlan(s, { maxNodes: 14 }))]) {
      const r = renderPlan(nodes, { maxCols: 200 }) as PlanRender
      const m = navModelFrom(nodes, r.boxes)
      const byId = new Map(r.boxes.map((b) => [b.id, b]))
      for (const e of r.edges) {
        const route = r.routes[`${e.from}>${e.to}`]
        const a = byId.get(e.from)!
        const b = byId.get(e.to)!
        const [r0, c0] = route[0]
        const [r1, c1] = route[route.length - 1]
        expect(r0).toBe(a.y + a.h)
        expect(c0 > a.x && c0 < a.x + a.w - 1).toBe(true)
        expect(r1).toBe(b.y - 1)
        expect(c1 > b.x && c1 < b.x + b.w - 1).toBe(true)
        expect(highlightCells(r, e.from).has(`${r1},${c1}`)).toBe(true)
      }
      expect(checkHighlightIncident(m, edgesOf(nodes), (id) => incidentEdges(r.edges, id))).toEqual([])
    }
  })
})

describe('viewport', () => {
  it('follows the selection and satisfies the viewport oracle for every box', () => {
    const r = renderPlan(NINE_TASK_PLAN, { maxCols: 60 }) as PlanRender
    const term = { cols: 40, rows: 12 }
    let v: Viewport = { left: 0, top: 0, width: 0, height: 0 }
    for (const b of r.boxes) {
      v = followSelection(v, b, r, term)
      expect(checkViewport(v, b, r, term)).toEqual([])
    }
    expect(scrollIndicators({ left: 0, top: 0, width: 10, height: 5 }, { width: 20, height: 5 })).toEqual({ up: false, down: false, left: false, right: true })
  })
})

describe('golden renders (committed under __golden__/, reviewed by a person)', () => {
  const plans: Record<string, VizNode[]> = { ...Object.fromEntries(Object.entries(NAMED_PLANS).map(([k, v]) => [`named-${k}`, v.nodes])), ...Object.fromEntries(Object.entries(templatePlans()).map(([k, v]) => [`template-${k}`, v])) }
  for (const [name, nodes] of Object.entries(plans)) for (const cols of [80, 120]) {
    it(`${name} at ${cols} columns`, async () => {
      const r = renderPlan(nodes, { maxCols: cols, selectedId: nodes[0]?.id }) as PlanRender
      await expect(`${r.fits ? '' : `(does not fit ${cols} columns: ${r.width} wide)\n`}${r.lines.join('\n')}\n`).toMatchFileSnapshot(`./__golden__/${name}.${cols}.txt`)
    })
  }
})
