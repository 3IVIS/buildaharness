import type { PlanRender } from './plan-raster.js'
import type { Edge } from './types.js'

/** The edges that touch a node: its incoming (dependencies) and outgoing (dependents) ones. */
export function incidentEdges(edges: readonly Edge[], id: string): Edge[] {
  return edges.filter((e) => e.from === id || e.to === id)
}

/** Every cell the incident edges of `id` are drawn through, as `"row,col"` keys (exact: the rasterizer reports its own routes). */
export function highlightCells(render: Pick<PlanRender, 'edges' | 'routes'>, id: string): Set<string> {
  const out = new Set<string>()
  for (const e of incidentEdges(render.edges, id)) for (const [r, c] of render.routes[`${e.from}>${e.to}`] ?? []) out.add(`${r},${c}`)
  return out
}
