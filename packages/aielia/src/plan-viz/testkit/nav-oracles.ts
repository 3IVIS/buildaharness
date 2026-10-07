import { dependentsOf } from './generators.js'
import type { Box, Edge, VizNode } from './types.js'

/**
 * The navigation specification and its oracles. `referenceNavigator` is the *executable specification*
 * of the pane's keys (section 5.4 of the plan); the production navigator must behave identically on the
 * property suite below. It was derived from the V10 simulation, where the obvious rule ("go to the
 * nearest connected node") stranded nodes in about 1.1–1.5% of plans and the final rule reached every
 * node in 3,000 of 3,000.
 *
 * Rules:
 *  - ↑ / ↓ follow edges to the nearest (by horizontal position) dependency / dependent. Pressing the SAME
 *    key again cycles through the other candidates of the node the sequence started from.
 *  - ← / → move to the neighbour in the same rank (by horizontal position), wrapping around.
 *  - Tab / Shift+Tab step through all nodes in task order, wrapping — a guaranteed way to reach any node.
 *  - A key with nothing to move to leaves the selection unchanged.
 */

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'shiftTab'

export interface NavModel {
  ids: string[]
  /** Task order, used by Tab (usually the plan's own order). */
  taskOrder: string[]
  /** Box centre x and top y; rank is decided by y (equal y = same rank). */
  x: Record<string, number>
  y: Record<string, number>
  deps: Record<string, string[]>
  dependents: Record<string, string[]>
}

export interface NavState {
  cur: string
  lastKey?: NavKey
  /** For a repeated vertical key: the node the cycling started from. */
  lastFrom?: string
  /** How many times the same vertical key has been repeated. */
  k: number
}

export interface Navigator {
  start(model: NavModel, id: string): NavState
  press(model: NavModel, state: NavState, key: NavKey): NavState
}

export function navModelFrom(nodes: readonly VizNode[], boxes: readonly Box[]): NavModel {
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const ids = nodes.map((n) => n.id).filter((id) => byId.has(id))
  return {
    ids,
    taskOrder: ids,
    x: Object.fromEntries(ids.map((id) => [id, byId.get(id)!.x + byId.get(id)!.w / 2])),
    y: Object.fromEntries(ids.map((id) => [id, byId.get(id)!.y])),
    deps: Object.fromEntries(nodes.map((n) => [n.id, n.deps.filter((d) => byId.has(d))])),
    dependents: dependentsOf(nodes),
  }
}

const byX = (m: NavModel, ids: readonly string[]): string[] => [...ids].sort((a, b) => m.x[a] - m.x[b] || (a < b ? -1 : a > b ? 1 : 0))

export const referenceNavigator: Navigator = {
  start: (_m, id) => ({ cur: id, k: 0 }),
  press(m, st, key) {
    if (key === 'tab' || key === 'shiftTab') {
      const i = m.taskOrder.indexOf(st.cur)
      const n = m.taskOrder.length
      return { cur: m.taskOrder[(i + (key === 'tab' ? 1 : -1) + n) % n], k: 0 }
    }
    if (key === 'up' || key === 'down') {
      let origin = st.lastKey === key && st.lastFrom !== undefined ? st.lastFrom : st.cur
      let cands = byX(m, key === 'up' ? m.deps[origin] : m.dependents[origin])
      // Repeating a vertical key cycles siblings only when there is something to cycle; with a single candidate it moves on from the current node instead of re-selecting it.
      let repeating = st.lastKey === key
      if (repeating && cands.length < 2) {
        origin = st.cur
        cands = byX(m, key === 'up' ? m.deps[origin] : m.dependents[origin])
        repeating = false
      }
      if (!cands.length) return st
      const nearest = [...cands].sort((a, b) => Math.abs(m.x[a] - m.x[origin]) - Math.abs(m.x[b] - m.x[origin]) || (a < b ? -1 : 1))[0]
      const k = repeating ? (st.k + 1) % cands.length : 0
      return { cur: cands[(cands.indexOf(nearest) + k) % cands.length], lastKey: key, lastFrom: origin, k }
    }
    const rank = byX(m, m.ids.filter((id) => m.y[id] === m.y[st.cur]))
    const i = rank.indexOf(st.cur)
    return { cur: rank[(i + (key === 'left' ? -1 : 1) + rank.length) % rank.length], lastKey: key, k: 0 }
  },
}

/** Every node reachable from `startId` using only the four arrow keys (explores real key state, with repeats). */
export function reachableByArrows(nav: Navigator, m: NavModel, startId: string): Set<string> {
  const seen = new Set<string>([startId])
  const visited = new Set<string>()
  const queue: NavState[] = [nav.start(m, startId)]
  while (queue.length) {
    const s = queue.shift()!
    const sig = `${s.cur}|${s.lastKey ?? ''}|${s.lastFrom ?? ''}|${s.k}`
    if (visited.has(sig)) continue
    visited.add(sig)
    for (const key of ['up', 'down', 'left', 'right'] as const) {
      const next = nav.press(m, s, key)
      seen.add(next.cur)
      queue.push(next)
    }
  }
  return seen
}

/** Arrow-only reachability: every node of a connected plan is reachable from the start node. */
export function checkReachability(nav: Navigator, m: NavModel, startId = m.ids[0]): string[] {
  if (!m.ids.length) return []
  const reached = reachableByArrows(nav, m, startId)
  const missing = m.ids.filter((id) => !reached.has(id))
  return missing.length ? [`from ${startId}, arrow keys cannot reach: ${missing.join(', ')}`] : []
}

/** Tab visits every node once in task order and returns to the start; Shift+Tab is its exact inverse. */
export function checkTabCycle(nav: Navigator, m: NavModel): string[] {
  const problems: string[] = []
  if (!m.ids.length) return problems
  let s = nav.start(m, m.taskOrder[0])
  const visited: string[] = [s.cur]
  for (let i = 0; i < m.taskOrder.length; i++) { s = nav.press(m, s, 'tab'); visited.push(s.cur) }
  if (visited.slice(0, -1).join(',') !== m.taskOrder.join(',')) problems.push('Tab does not visit nodes in task order')
  if (visited[visited.length - 1] !== m.taskOrder[0]) problems.push('Tab does not wrap back to the first node')
  for (const id of m.ids) {
    const back = nav.press(m, nav.press(m, nav.start(m, id), 'tab'), 'shiftTab').cur
    if (back !== id) problems.push(`Shift+Tab after Tab from ${id} lands on ${back}`)
  }
  return problems
}

/** A vertical key with no candidate leaves the selection (and state) untouched. */
export function checkBoundaries(nav: Navigator, m: NavModel): string[] {
  const problems: string[] = []
  for (const id of m.ids) {
    const s = nav.start(m, id)
    if (!m.deps[id].length && nav.press(m, s, 'up').cur !== id) problems.push(`↑ on ${id} (no dependencies) moved the selection`)
    if (!m.dependents[id].length && nav.press(m, s, 'down').cur !== id) problems.push(`↓ on ${id} (no dependents) moved the selection`)
  }
  return problems
}

/** ← and → stay in the rank, wrap, and are inverses of each other. */
export function checkHorizontal(nav: Navigator, m: NavModel): string[] {
  const problems: string[] = []
  for (const id of m.ids) {
    const s = nav.start(m, id)
    const right = nav.press(m, s, 'right').cur
    const left = nav.press(m, s, 'left').cur
    if (m.y[right] !== m.y[id] || m.y[left] !== m.y[id]) problems.push(`← or → from ${id} left its rank`)
    if (nav.press(m, nav.press(m, s, 'right'), 'left').cur !== id) problems.push(`→ then ← from ${id} does not return`)
    const rank = m.ids.filter((o) => m.y[o] === m.y[id])
    let cur = nav.start(m, id)
    for (let i = 0; i < rank.length; i++) cur = nav.press(m, cur, 'right')
    if (cur.cur !== id) problems.push(`${rank.length} presses of → in a rank of ${rank.length} do not wrap back to ${id}`)
  }
  return problems
}

/** Repeating ↓ (↑) visits each dependent (dependency) exactly once, then wraps. */
export function checkRepeatCycles(nav: Navigator, m: NavModel): string[] {
  const problems: string[] = []
  for (const id of m.ids) for (const [key, cands] of [['down', m.dependents[id]], ['up', m.deps[id]]] as const) {
    if (cands.length < 2) continue
    let s = nav.start(m, id)
    const seen: string[] = []
    for (let i = 0; i < cands.length; i++) { s = nav.press(m, s, key); seen.push(s.cur) }
    if (new Set(seen).size !== cands.length || !seen.every((c) => cands.includes(c))) problems.push(`repeating ${key} from ${id} does not visit each of ${cands.join(', ')} exactly once (visited ${seen.join(', ')})`)
    s = nav.press(m, s, key)
    if (s.cur !== seen[0]) problems.push(`repeating ${key} from ${id} does not wrap to the first candidate`)
  }
  return problems
}

/** The highlighted edges for a selection are exactly the edges touching that node. */
export function checkHighlightIncident(m: NavModel, edges: readonly Edge[], highlight: (id: string) => readonly Edge[]): string[] {
  const problems: string[] = []
  const key = (e: Edge): string => `${e.from}>${e.to}`
  for (const id of m.ids) {
    const want = new Set(edges.filter((e) => e.from === id || e.to === id).map(key))
    const got = new Set(highlight(id).map(key))
    for (const w of want) if (!got.has(w)) problems.push(`selecting ${id} does not highlight ${w}`)
    for (const g of got) if (!want.has(g)) problems.push(`selecting ${id} highlights unrelated edge ${g}`)
  }
  return problems
}

// ── viewport ─────────────────────────────────────────────────────────────────────────────────────

export interface Viewport {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Executable specification for panning: keep the selected box fully visible when it fits, never leave
 * the diagram, and never exceed the terminal. Scrolls the minimum amount from the previous viewport so the
 * picture does not jump while navigating.
 */
export function followSelection(prev: Viewport, box: Box, grid: { width: number; height: number }, term: { cols: number; rows: number }): Viewport {
  const width = Math.min(term.cols, grid.width)
  const height = Math.min(term.rows, grid.height)
  const fit = (start: number, size: number, bStart: number, bSize: number, total: number): number => {
    let s = start
    if (bStart < s) s = bStart
    if (bStart + bSize > s + size) s = bStart + bSize - size
    return Math.max(0, Math.min(s, total - size))
  }
  return { width, height, left: fit(prev.left, width, box.x, box.w, grid.width), top: fit(prev.top, height, box.y, box.h, grid.height) }
}

export function checkViewport(v: Viewport, box: Box, grid: { width: number; height: number }, term: { cols: number; rows: number }): string[] {
  const problems: string[] = []
  if (v.width > term.cols || v.height > term.rows) problems.push('viewport is larger than the terminal')
  if (v.left < 0 || v.top < 0 || v.left + v.width > grid.width || v.top + v.height > grid.height) problems.push('viewport leaves the diagram')
  const fitsX = box.w <= v.width
  const fitsY = box.h <= v.height
  if (fitsX && (box.x < v.left || box.x + box.w > v.left + v.width)) problems.push(`selected box ${box.id} is not horizontally visible`)
  if (fitsY && (box.y < v.top || box.y + box.h > v.top + v.height)) problems.push(`selected box ${box.id} is not vertically visible`)
  return problems
}
