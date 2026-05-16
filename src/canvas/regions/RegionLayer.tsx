/**
 * RegionLayer — auto-derived swimlanes for parallel and debate scopes.
 *
 * Renders a dashed background rectangle behind each:
 *   • parallel_fork → parallel_join pair (green tint)
 *   • agent_debate node (magenta tint, full bounds = the node itself)
 *
 * No new node type, no new store data. Pure derivation from the canvas
 * graph + node positions. Sits inside <ReactFlow> via <ViewportPortal>
 * so it pans and zooms with the canvas.
 *
 * Usage (inside the <ReactFlow>...</ReactFlow> children):
 *   <RegionLayer />
 */
import { useMemo } from 'react'
import { ViewportPortal, type Node } from '@xyflow/react'
import { useCanvasStore } from '../../store'
import type { NodeType } from '../../spec/schema'

// Approximate node footprint — matches the cf-node CSS min/max width and
// average rendered height (header + body + compat row). Kept conservative.
const NODE_W = 220
// NODE_H covers: header(~44) + body(~40) + compat(~24) + exec badge(~20) + error footer(~28) + 12 padding
// Erring on the generous side so regions never clip tall node states.
const NODE_H = 168

interface Region {
  id:     string
  kind:   'parallel' | 'debate'
  x:      number
  y:      number
  width:  number
  height: number
  label:  string
}

function unionBounds(positions: Array<{ x: number; y: number }>): {
  minX: number; minY: number; maxX: number; maxY: number
} | null {
  if (positions.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of positions) {
    if (p.x         < minX) minX = p.x
    if (p.y         < minY) minY = p.y
    if (p.x + NODE_W > maxX) maxX = p.x + NODE_W
    if (p.y + NODE_H > maxY) maxY = p.y + NODE_H
  }
  return { minX, minY, maxX, maxY }
}

// Walk forward from `from` along graph edges, collecting every node reachable
// before hitting `until`. Used to discover the body of a parallel_fork / join
// pair regardless of intermediate node count.
function reachableBetween(
  fromId:  string,
  untilId: string,
  edges:   { source: string; target: string }[],
): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }
  const visited = new Set<string>()
  const stack   = [fromId]
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    if (id === untilId) continue
    for (const next of adj.get(id) ?? []) {
      if (!visited.has(next)) stack.push(next)
    }
  }
  return visited
}

export function RegionLayer() {
  const nodes = useCanvasStore((s) => s.nodes) as Node[]
  const edges = useCanvasStore((s) => s.edges)

  const regions: Region[] = useMemo(() => {
    const out: Region[] = []
    const byId = new Map(nodes.map((n) => [n.id, n]))

    // ── 1) parallel scopes: pair each fork with its nearest reachable join ──
    const forks = nodes.filter((n) => (n.type as NodeType) === 'parallel_fork')
    const joins = nodes.filter((n) => (n.type as NodeType) === 'parallel_join')

    for (const fork of forks) {
      // Find the join reachable from this fork — use the first one we hit.
      let joinId: string | null = null
      const visited = new Set<string>()
      const stack   = [fork.id]
      while (stack.length) {
        const id = stack.pop()!
        if (visited.has(id)) continue
        visited.add(id)
        if (id !== fork.id && joins.some((j) => j.id === id)) {
          joinId = id
          break
        }
        for (const e of edges) {
          if (e.source === id) stack.push(e.target)
        }
      }
      if (!joinId) continue

      const inside = reachableBetween(fork.id, joinId, edges)
      const positions = [...inside]
        .map((id) => byId.get(id)?.position)
        .filter((p): p is { x: number; y: number } => !!p)
      // Always include both endpoints
      const forkPos = byId.get(fork.id)?.position
      const joinPos = byId.get(joinId)?.position
      if (forkPos) positions.push(forkPos)
      if (joinPos) positions.push(joinPos)

      const b = unionBounds(positions)
      if (!b) continue

      const pad = 24
      out.push({
        id:     `region-${fork.id}-${joinId}`,
        kind:   'parallel',
        x:      b.minX - pad,
        y:      b.minY - pad - 14,  // extra room for label
        width:  b.maxX - b.minX + pad * 2,
        height: b.maxY - b.minY + pad * 2 + 14,
        // inside.size includes the fork node itself; -1 gives true branch count.
        label:  `parallel · ${inside.size - 1} branches`,
      })
    }

    // ── 2) debate scopes: just wrap the agent_debate node itself ─────────
    for (const n of nodes) {
      if ((n.type as NodeType) !== 'agent_debate') continue
      const cfg = (n.data as { config?: { max_rounds?: number; agents?: string[] } })?.config ?? {}
      const rounds = cfg.max_rounds ?? 10
      const agents = cfg.agents?.length ?? 0
      const pad = 18
      out.push({
        id:     `region-${n.id}`,
        kind:   'debate',
        x:      n.position.x - pad,
        y:      n.position.y - pad - 14,
        width:  NODE_W + pad * 2,
        height: NODE_H + pad * 2 + 14,
        label:  `debate · ${agents} agents · max ${rounds} rounds`,
      })
    }

    return out
  }, [nodes, edges])

  return (
    <ViewportPortal>
      {regions.map((r) => (
        <div
          key={r.id}
          className={`region region--${r.kind}`}
          style={{
            position: 'absolute',
            left:     r.x,
            top:      r.y,
            width:    r.width,
            height:   r.height,
            pointerEvents: 'none',
            // zIndex is implicit — ViewportPortal renders BELOW nodes when
            // children are stacked first; we render <RegionLayer/> before
            // any other ViewportPortal users.
          }}
        >
          <span className="region__label">{r.label}</span>
        </div>
      ))}
    </ViewportPortal>
  )
}
