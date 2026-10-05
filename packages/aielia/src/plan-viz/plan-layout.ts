import dagre from '@dagrejs/dagre'
import { normalizePlanNodes } from './normalize.js'
import { displayWidth, fitLabel, sanitizeLabel } from './plan-width.js'
import type { VizNode } from './types.js'

/** Above this many nodes the picture is not useful in a terminal; callers fall back to the checklist. */
export const MAX_PLAN_NODES = 150
/** Dense plans (hundreds of dependencies) turn into a wall of lines; same checklist fallback as the node cap. */
export const MAX_PLAN_EDGES = 600
export const BOX_HEIGHT = 3
/** Cells a box adds around its label region: two borders, a pad either side, the glyph and a space. */
const BOX_CHROME = 6
const MIN_LABEL = 8
const GAP_BOX = 3
const GAP_OTHER = 2

/** A box (real) or a one-column waypoint of an edge that skips ranks (virtual). */
export interface LayoutItem {
  uid: number
  rank: number
  x: number
  w: number
  virtual: boolean
  /** Real items only. */
  node?: VizNode
  /** Visible label text of a real item (sanitized and shortened). */
  label?: string
  /** Virtual items: the chain they belong to, so adjacent-rank waypoints of one edge may share a column. */
  chain?: number
}

export interface EdgeChain {
  from: string
  to: string
  /** Source box, waypoints in rank order, target box. */
  items: LayoutItem[]
}

export interface PlanLayout {
  ok: true
  nodes: VizNode[]
  ranks: LayoutItem[][]
  chains: EdgeChain[]
  byId: Map<string, LayoutItem>
  width: number
  warnings: string[]
}

export type LayoutFailure = { ok: false; reason: 'empty' | 'too_large' | 'cannot_draw'; message: string }

export const LABEL_FLOOR = MIN_LABEL

/**
 * Layered layout in character units. dagre decides the ranks and the left-to-right order (dummy nodes
 * included); positions are then legalized per rank so boxes never touch and waypoints keep clear of boxes.
 * Deterministic: nodes and edges are inserted in task order and nothing in the input depends on status, so
 * a status change never moves a box.
 */
export function layoutPlan(input: readonly VizNode[], labelMax: number): PlanLayout | LayoutFailure {
  const { nodes, warnings } = normalizePlanNodes(input)
  if (!nodes.length) return { ok: false, reason: 'empty', message: 'the plan has no tasks' }
  if (nodes.length > MAX_PLAN_NODES) return { ok: false, reason: 'too_large', message: `the plan has ${nodes.length} tasks (the graph shows at most ${MAX_PLAN_NODES})` }

  const edgeCount = nodes.reduce((a, n) => a + n.deps.length, 0)
  if (edgeCount > MAX_PLAN_EDGES) return { ok: false, reason: 'too_large', message: `the plan has ${edgeCount} dependencies (the graph shows at most ${MAX_PLAN_EDGES})` }

  const items: LayoutItem[] = nodes.map((node, i) => {
    const label = fitLabel(sanitizeLabel(node.label) || sanitizeLabel(node.id) || '?', Math.max(MIN_LABEL, labelMax))
    return { uid: i, rank: 0, x: 0, w: Math.max(displayWidth(label), 1) + BOX_CHROME, virtual: false, node, label }
  })
  const byId = new Map(items.map((it) => [it.node!.id, it]))

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: GAP_BOX + 1, edgesep: GAP_OTHER + 1, ranksep: 4, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  items.forEach((it, i) => g.setNode(`n${i}`, { width: it.w, height: BOX_HEIGHT }))
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  for (const n of nodes) for (const d of n.deps) g.setEdge(`n${idx.get(d)}`, `n${idx.get(n.id)}`)
  dagre.layout(g)

  const ys = [...new Set(items.map((_, i) => Math.round(g.node(`n${i}`).y)))].sort((a, b) => a - b)
  items.forEach((it, i) => {
    const p = g.node(`n${i}`)
    it.rank = ys.indexOf(Math.round(p.y))
    it.x = Math.round(p.x - it.w / 2)
  })

  const ranks: LayoutItem[][] = ys.map(() => [])
  items.forEach((it) => ranks[it.rank].push(it))
  const chains: EdgeChain[] = []
  let uid = items.length
  for (const n of nodes) for (const d of n.deps) {
    const a = items[idx.get(d)!]
    const b = items[idx.get(n.id)!]
    const span = b.rank - a.rank
    if (span < 1) return { ok: false, reason: 'cannot_draw', message: `${n.id} is not ranked below ${d}` }
    const pts = (g.edge(`n${idx.get(d)}`, `n${idx.get(n.id)}`) as { points?: Array<{ x: number }> }).points ?? []
    const chain: LayoutItem[] = [a]
    for (let k = 1; k < span; k++) {
      const px = pts.length === span + 1 ? pts[k].x : (a.x + a.w / 2) + ((b.x + b.w / 2) - (a.x + a.w / 2)) * (k / span)
      const v: LayoutItem = { uid: uid++, rank: a.rank + k, x: Math.round(px), w: 1, virtual: true, chain: chains.length }
      ranks[v.rank].push(v)
      chain.push(v)
    }
    chain.push(b)
    chains.push({ from: d, to: n.id, items: chain })
  }

  const legalize = (row: LayoutItem[]): void => {
    row.sort((p, q) => p.x - q.x || p.uid - q.uid)
    for (let i = 1; i < row.length; i++) {
      const gap = row[i - 1].virtual || row[i].virtual ? GAP_OTHER : GAP_BOX
      row[i].x = Math.max(row[i].x, row[i - 1].x + row[i - 1].w + gap)
    }
  }
  ranks.forEach(legalize)
  const minX = Math.min(...ranks.flat().map((it) => it.x))
  if (minX !== 0) ranks.flat().forEach((it) => { it.x -= minX })

  // Waypoints of unrelated edges in adjacent ranks must not share a column (their stems would merge in the gap between).
  const clashes = (v: LayoutItem): boolean => [v.rank - 1, v.rank + 1].some((r) => (ranks[r] ?? []).some((o) => o.virtual && o.x === v.x && o.chain !== v.chain))
  for (let pass = 0; pass < 40; pass++) {
    let changed = false
    for (const row of ranks) for (const v of row) if (v.virtual && clashes(v)) { v.x += 1; legalize(row); changed = true }
    if (!changed) break
  }
  if (ranks.flat().some((v) => v.virtual && clashes(v))) return { ok: false, reason: 'cannot_draw', message: 'edge waypoints could not be separated' }

  const width = Math.max(...ranks.flat().map((it) => it.x + it.w))
  return { ok: true, nodes, ranks, chains, byId, width, warnings }
}
