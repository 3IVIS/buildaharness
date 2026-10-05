import type { VizNode } from './types.js'

export interface NormalizedNodes {
  nodes: VizNode[]
  /** What was repaired, one human-readable line each (duplicate ids, unknown/self dependencies, broken cycles). */
  warnings: string[]
}

/**
 * Makes any node list safe for the layout and rasterizer: drops duplicate ids (first wins), unknown and
 * self dependencies, duplicate dependencies, and breaks cycles by removing the edge that closes one
 * (depth-first in input order, so the result is deterministic). Never throws and never mutates its input.
 * Behaviour is specified by `normalizePlan` in testkit/generators.ts and differential-tested against it.
 * The depth-first walk is iterative so a very deep chain cannot overflow the stack.
 */
export function normalizePlanNodes(input: readonly VizNode[]): NormalizedNodes {
  const warnings: string[] = []
  const seen = new Set<string>()
  const nodes: VizNode[] = []
  for (const n of input) {
    if (seen.has(n.id)) { warnings.push(`duplicate id ${n.id}`); continue }
    seen.add(n.id)
    nodes.push({ ...n, deps: [...new Set(n.deps ?? [])] })
  }
  for (const n of nodes) {
    n.deps = n.deps.filter((d) => {
      if (d === n.id) { warnings.push(`self dependency ${n.id}`); return false }
      if (!seen.has(d)) { warnings.push(`unknown dependency ${d} of ${n.id}`); return false }
      return true
    })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const state = new Map<string, 1 | 2>()
  for (const root of nodes) {
    if (state.has(root.id)) continue
    state.set(root.id, 1)
    // Each frame filters one node's deps in order, descending into an unvisited dependency before moving on.
    const stack: { id: string; deps: string[]; i: number; kept: string[] }[] = [{ id: root.id, deps: byId.get(root.id)!.deps, i: 0, kept: [] }]
    while (stack.length) {
      const f = stack[stack.length - 1]
      if (f.i >= f.deps.length) {
        byId.get(f.id)!.deps = f.kept
        state.set(f.id, 2)
        stack.pop()
        continue
      }
      const d = f.deps[f.i++]
      if (state.get(d) === 1) { warnings.push(`cycle broken: ${f.id} -> ${d}`); continue }
      f.kept.push(d)
      if (!state.has(d)) {
        state.set(d, 1)
        stack.push({ id: d, deps: byId.get(d)!.deps, i: 0, kept: [] })
      }
    }
  }
  return { nodes, warnings }
}
