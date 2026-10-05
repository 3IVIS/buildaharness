import type { Box, VizNode } from './types.js'

/**
 * Keyboard navigation over the plan graph (section 5.4). Same behaviour as `referenceNavigator` in
 * testkit/nav-oracles.ts (copied: production code does not import the kit); a differential test keeps them equal.
 * Pure: no I/O. Read-only: it only moves a selection.
 */

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'shiftTab'

export interface NavModel {
  ids: string[]
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
  k: number
}

export interface Navigator {
  start(model: NavModel, id: string): NavState
  press(model: NavModel, state: NavState, key: NavKey): NavState
}

export function navModelFrom(nodes: readonly VizNode[], boxes: readonly Box[]): NavModel {
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const ids = nodes.map((n) => n.id).filter((id) => byId.has(id))
  const dependents: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]))
  for (const n of nodes) if (byId.has(n.id)) for (const d of n.deps) if (dependents[d]) dependents[d].push(n.id)
  return {
    ids,
    taskOrder: ids,
    x: Object.fromEntries(ids.map((id) => [id, byId.get(id)!.x + byId.get(id)!.w / 2])),
    y: Object.fromEntries(ids.map((id) => [id, byId.get(id)!.y])),
    deps: Object.fromEntries(nodes.map((n) => [n.id, n.deps.filter((d) => byId.has(d))])),
    dependents,
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byX = (m: NavModel, ids: readonly string[]): string[] => [...ids].sort((a, b) => m.x[a] - m.x[b] || cmp(a, b))

export const planNavigator: Navigator = {
  start: (_m, id) => ({ cur: id, k: 0 }),
  press(m, st, key) {
    if (key === 'tab' || key === 'shiftTab') {
      const n = m.taskOrder.length
      if (!n) return st
      const i = m.taskOrder.indexOf(st.cur)
      return { cur: m.taskOrder[(i + (key === 'tab' ? 1 : -1) + n) % n], k: 0 }
    }
    if (key === 'up' || key === 'down') {
      const origin = st.lastKey === key && st.lastFrom !== undefined ? st.lastFrom : st.cur
      const cands = byX(m, (key === 'up' ? m.deps[origin] : m.dependents[origin]) ?? [])
      if (!cands.length) return st
      const nearest = [...cands].sort((a, b) => Math.abs(m.x[a] - m.x[origin]) - Math.abs(m.x[b] - m.x[origin]) || cmp(a, b))[0]
      const k = st.lastKey === key ? (st.k + 1) % cands.length : 0
      return { cur: cands[(cands.indexOf(nearest) + k) % cands.length], lastKey: key, lastFrom: origin, k }
    }
    const rank = byX(m, m.ids.filter((id) => m.y[id] === m.y[st.cur]))
    const i = rank.indexOf(st.cur)
    if (i < 0) return st
    return { cur: rank[(i + (key === 'left' ? -1 : 1) + rank.length) % rank.length], lastKey: key, k: 0 }
  },
}
