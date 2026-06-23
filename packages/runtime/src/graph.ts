import type { Node, Edge } from '@buildaharness/canvas'
import { GraphCycleError, FlowExecutionError } from './errors'

export class FlowGraph {
  private nodeMap: Map<string, Node>
  private fwd: Map<string, string[]>
  private bwd: Map<string, string[]>
  private order: string[]

  constructor(nodes: Node[], edges: Edge[]) {
    this.nodeMap = new Map(nodes.map(n => [n.id, n]))
    this.fwd = new Map(nodes.map(n => [n.id, [] as string[]]))
    this.bwd = new Map(nodes.map(n => [n.id, [] as string[]]))

    for (const edge of edges) {
      if (edge.type === 'direct') {
        this._addEdge(edge.from, edge.to)
      } else if (edge.type === 'conditional') {
        for (const branch of edge.branches) {
          this._addEdge(edge.from, branch.to)
        }
        this._addEdge(edge.from, edge.default_target)
      }
    }

    if (this.nodeMap.size > 0 && !this._isConnected()) {
      throw new FlowExecutionError({ nodeId: 'graph', message: 'FlowSpec contains a disconnected subgraph — all nodes must be reachable from the root' })
    }

    this.order = this._topoSort()
  }

  private _addEdge(from: string, to: string): void {
    this.fwd.get(from)?.push(to)
    this.bwd.get(to)?.push(from)
  }

  private _isConnected(): boolean {
    if (this.nodeMap.size <= 1) return true
    // Undirected reachability — treat all edges as bidirectional to detect
    // isolated components (e.g. orphan node with no edges at all)
    const startId = this.nodeMap.keys().next().value!
    const visited = new Set<string>()
    const queue = [startId]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const nb of [...(this.fwd.get(id) ?? []), ...(this.bwd.get(id) ?? [])]) {
        if (!visited.has(nb)) queue.push(nb)
      }
    }
    return visited.size === this.nodeMap.size
  }

  private _topoSort(): string[] {
    const inDegree = new Map<string, number>()
    for (const id of this.nodeMap.keys()) {
      inDegree.set(id, this.bwd.get(id)!.length)
    }

    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const sorted: string[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      sorted.push(id)
      for (const succ of this.fwd.get(id)!) {
        const newDeg = inDegree.get(succ)! - 1
        inDegree.set(succ, newDeg)
        if (newDeg === 0) queue.push(succ)
      }
    }

    if (sorted.length !== this.nodeMap.size) {
      const inCycle = [...inDegree.entries()]
        .filter(([, deg]) => deg > 0)
        .map(([id]) => id)
      throw new GraphCycleError({ nodeIds: inCycle })
    }

    return sorted
  }

  roots(): string[] {
    return [...this.nodeMap.keys()].filter(id => (this.bwd.get(id)?.length ?? 0) === 0)
  }

  leaves(): string[] {
    return [...this.nodeMap.keys()].filter(id => (this.fwd.get(id)?.length ?? 0) === 0)
  }

  successors(nodeId: string): string[] {
    return [...(this.fwd.get(nodeId) ?? [])]
  }

  predecessors(nodeId: string): string[] {
    return [...(this.bwd.get(nodeId) ?? [])]
  }

  getNode(nodeId: string): Node | undefined {
    return this.nodeMap.get(nodeId)
  }

  topoOrder(): string[] {
    return [...this.order]
  }
}
