import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '@buildaharness/harness'
import { planToSnapshot } from './plan-snapshot.js'
import { renderPlan } from './plan-raster.js'
import { normalizePlanNodes } from './normalize.js'
import { navModelFrom, planNavigator, type NavKey } from './plan-nav.js'
import { followSelection, type Viewport } from './plan-viewport.js'
import { MAX_PLAN_NODES } from './plan-layout.js'
import { checkRender } from './testkit/grid-oracles.js'
import { MALFORMED_PLANS, rng } from './testkit/generators.js'
import type { PlanRecord, PlanTaskRecord } from '../plan-store.js'
import type { VizNode } from './types.js'
import { VIZ_STATUSES } from './types.js'

// eslint-disable-next-line no-control-regex
const strip = (lines: string[]): string[] => lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))
const T = (id: string, status: TaskStatus, depends_on: string[] = [], extra: Partial<PlanTaskRecord> = {}): PlanTaskRecord => ({ id, description: `Task ${id}`, depends_on, status, ...extra })
const plan = (tasks: PlanTaskRecord[], mode: PlanRecord['mode'] = 'active'): PlanRecord => ({ templateName: null, successCriteria: 'Ship it', rationale: 'because', tasks, mode, executingOnPlan: true, createdAt: 'x', updatedAt: 'x' })

/** Render and run the grid oracles; returns violations, or [] when the checklist fallback engaged with a reason. */
function violations(nodes: VizNode[], maxCols: number, ascii = false): string[] {
  const r = renderPlan(nodes, { maxCols, ascii })
  if (!r.ok) return r.message ? [] : ['failure without a reason']
  return checkRender({ render: { lines: strip(r.lines), boxes: r.boxes, edges: r.edges }, nodes: normalizePlanNodes(nodes).nodes, maxCols: r.fits ? maxCols : undefined, labels: ascii ? undefined : r.labels, opts: { ascii } })
}

describe('end to end: the graph advances per checkpoint', () => {
  const tasks = [T('a', 'PENDING'), T('b', 'PENDING', ['a']), T('c', 'PENDING', ['a']), T('d', 'PENDING', ['b', 'c'])]
  const statusOf = (nodes: VizNode[], id: string): string => nodes.find((n) => n.id === id)!.status

  it('statuses follow the plan record through every checkpoint, and every frame is oracle-clean', () => {
    const steps: Array<[TaskStatus[], Record<string, string>]> = [
      [['PENDING', 'PENDING', 'PENDING', 'PENDING'], { a: 'ready', b: 'pending', c: 'pending', d: 'pending' }],
      [['RUNNING', 'PENDING', 'PENDING', 'PENDING'], { a: 'running', b: 'pending' }],
      [['COMPLETE', 'RUNNING', 'PENDING', 'PENDING'], { a: 'done', b: 'running', c: 'ready' }],
      [['COMPLETE', 'COMPLETE', 'FAILED', 'PENDING'], { b: 'done', c: 'failed', d: 'pending' }],
      [['COMPLETE', 'COMPLETE', 'COMPLETE', 'COMPLETE'], { c: 'done', d: 'done' }],
    ]
    let prevBoxes: string | undefined
    for (const [statuses, expected] of steps) {
      const { nodes } = planToSnapshot(plan(tasks.map((t, i) => ({ ...t, status: statuses[i] }))))
      for (const [id, s] of Object.entries(expected)) expect(statusOf(nodes, id)).toBe(s)
      expect(violations(nodes, 100)).toEqual([])
      // A status change must not move boxes (layout is status-independent).
      const r = renderPlan(nodes, { maxCols: 100 })
      if (!r.ok) throw new Error(r.message)
      const boxes = JSON.stringify(r.boxes)
      if (prevBoxes !== undefined) expect(boxes).toBe(prevBoxes)
      prevBoxes = boxes
    }
  })

  it('a live overlay from a running turn advances the graph without touching the record', () => {
    const record = plan(tasks)
    const { nodes } = planToSnapshot(record, [{ id: 'a', status: 'COMPLETE' }, { id: 'b', status: 'RUNNING' }])
    expect(statusOf(nodes, 'a')).toBe('done')
    expect(statusOf(nodes, 'b')).toBe('running')
    expect(statusOf(nodes, 'c')).toBe('ready')
    expect(record.tasks[0].status).toBe('PENDING')
  })

  it('a draft in awaiting_approval renders, with its cancellations marked', () => {
    const draft = plan([T('a', 'PENDING'), T('b', 'COMPLETE', ['a'], { cancelled: true }), T('c', 'PENDING', ['a'])], 'awaiting_approval')
    const { nodes, snapshot } = planToSnapshot(draft)
    expect(statusOf(nodes, 'b')).toBe('cancelled')
    expect(snapshot.nodes.b.metadata.description.startsWith('⊘')).toBe(true)
    expect(violations(nodes, 80)).toEqual([])
    expect(violations(nodes, 80, true)).toEqual([])
  })
})

describe('robustness: garbage plans never throw or hang', () => {
  const CHARS = ['a', 'Z', ' ', '\n', '\t', '\u0007', '\u001b', '\u202e', '\u2066', '\u200b', '界', '😀', 'é', '\u0301', '\u0000']
  // Labels that mimic the line characters themselves are a known oracle limitation (R1 note): survive them, but do not oracle-check them.
  const LINE_CHARS = ['|', '+', '-', '─', '│', '┌']
  const garbageLabel = (r: () => number, alphabet: string[] = CHARS): string => Array.from({ length: Math.floor(r() * 30) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('')

  function garbagePlan(seed: number): VizNode[] {
    const r = rng(seed)
    const n = Math.floor(r() * 25)
    const pool = Array.from({ length: n + 3 }, (_, i) => (r() < 0.2 ? garbageLabel(r) || 'x' : `id${i % Math.max(1, n)}`))
    return Array.from({ length: n }, () => ({
      id: pool[Math.floor(r() * pool.length)],
      label: garbageLabel(r),
      status: VIZ_STATUSES[Math.floor(r() * VIZ_STATUSES.length)],
      deps: Array.from({ length: Math.floor(r() * 4) }, () => pool[Math.floor(r() * pool.length)]),
    }))
  }

  it('300 seeded garbage plans through adapter, layout, rasterizer and navigator', () => {
    const keys: NavKey[] = ['up', 'down', 'left', 'right', 'tab', 'shiftTab']
    for (let seed = 1; seed <= 300; seed++) {
      const nodes = garbagePlan(seed)
      const cols = [20, 40, 80, 160][seed % 4]
      const tasks = nodes.map((n) => T(n.id, 'PENDING', n.deps, { description: n.label }))
      const snap = planToSnapshot(plan(tasks))
      expect(violations(snap.nodes, cols), `seed ${seed} (adapter)`).toEqual([])
      expect(violations(nodes, cols, seed % 2 === 0), `seed ${seed} (raw)`).toEqual([])
      const r = renderPlan(nodes, { maxCols: cols })
      if (!r.ok || !r.boxes.length) continue
      const model = navModelFrom(normalizePlanNodes(nodes).nodes.filter((n) => r.boxes.some((b) => b.id === n.id)), r.boxes)
      let st = planNavigator.start(model, r.boxes[0].id)
      let vp: Viewport = { left: 0, top: 0, width: 0, height: 0 }
      const rr = rng(seed)
      for (let i = 0; i < 20; i++) {
        st = planNavigator.press(model, st, keys[Math.floor(rr() * keys.length)])
        expect(model.ids).toContain(st.cur)
        const box = r.boxes.find((b) => b.id === st.cur)!
        vp = followSelection(vp, box, { width: r.width, height: r.height }, { cols, rows: 10 })
      }
    }
  }, 60_000)

  it('labels made of line characters never throw', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const nodes: VizNode[] = Array.from({ length: 1 + (seed % 8) }, (_, i) => ({ id: `n${i}`, label: garbageLabel(r, [...CHARS, ...LINE_CHARS]), status: 'pending', deps: i ? [`n${i - 1}`] : [] }))
      expect(() => renderPlan(nodes, { maxCols: 40, ascii: seed % 2 === 0 }), `seed ${seed}`).not.toThrow()
    }
  })

  it('every MALFORMED_PLANS entry survives the whole pipeline', () => {
    for (const [name, nodes] of Object.entries(MALFORMED_PLANS)) {
      expect(() => planToSnapshot(plan(nodes.map((n) => T(n.id, 'PENDING', n.deps, { description: n.label })))), name).not.toThrow()
      expect(violations(nodes, 80), name).toEqual([])
    }
  })

  it('empty plan: the renderer reports a reason instead of throwing', () => {
    const r = renderPlan([], { maxCols: 80 })
    expect(r.ok).toBe(false)
  })

  it('a 1,000-node plan engages the fallback with a reason (over the node cap)', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `M${i}`, label: `Task ${i}`, status: 'pending' as const, deps: i ? [`M${i - 1}`] : [] }))
    const start = Date.now()
    const r = renderPlan(nodes, { maxCols: 80 })
    expect(Date.now() - start).toBeLessThan(5000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('too_large')
      expect(r.message.length).toBeGreaterThan(0)
    }
  })

  it('a plan at the node cap does not hang', () => {
    const nodes = Array.from({ length: MAX_PLAN_NODES }, (_, i) => ({ id: `M${i}`, label: `Task ${i}`, status: 'pending' as const, deps: i >= 3 ? [`M${i - 3}`] : [] }))
    const start = Date.now()
    renderPlan(nodes, { maxCols: 100 })
    expect(Date.now() - start).toBeLessThan(2000 * 3)
  })
})

describe('performance budgets (recorded x3 headroom)', () => {
  const chain = (n: number, fan: number): VizNode[] => Array.from({ length: n }, (_, i) => ({ id: `P${i}`, label: `Step ${i} of the plan`, status: VIZ_STATUSES[i % VIZ_STATUSES.length], deps: i >= fan ? [`P${i - fan}`] : [] }))
  const time = (fn: () => void): number => { const s = performance.now(); fn(); return performance.now() - s }

  it('25 nodes: layout plus raster under 300 ms', () => {
    renderPlan(chain(25, 3), { maxCols: 100 })
    expect(time(() => renderPlan(chain(25, 3), { maxCols: 100 }))).toBeLessThan(300)
  })

  it('150 sparse nodes: layout plus raster under 2 s', () => {
    expect(time(() => renderPlan(chain(MAX_PLAN_NODES, 10), { maxCols: 100 }))).toBeLessThan(2000)
  })
})

describe('soak: 1,000 consecutive updates', () => {
  it('output stays the same size and heap growth is bounded', () => {
    const statuses: TaskStatus[] = ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED']
    const base = Array.from({ length: 12 }, (_, i) => T(`t${i}`, 'PENDING', i >= 2 ? [`t${i - 2}`] : []))
    const sizes = new Set<number>()
    const heapBefore = (() => { globalThis.gc?.(); return process.memoryUsage().heapUsed })()
    let lastLines = 0
    for (let i = 0; i < 1000; i++) {
      const live = base.map((t, j) => ({ id: t.id, status: statuses[(i + j) % statuses.length] }))
      const { nodes } = planToSnapshot(plan(base), live)
      const r = renderPlan(nodes, { maxCols: 100, selectedId: `t${i % 12}` })
      if (!r.ok) throw new Error(r.message)
      sizes.add(r.height * 1000 + r.width)
      lastLines = r.lines.length
      expect(r.boxes.length).toBe(nodes.length)
    }
    expect(sizes.size).toBe(1)
    expect(lastLines).toBeGreaterThan(0)
    globalThis.gc?.()
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150 * 1024 * 1024)
  }, 60_000)
})
