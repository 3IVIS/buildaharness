import { describe, it, expect } from 'vitest'
import { FlowGraph } from './graph'
import { GraphCycleError, FlowExecutionError } from './errors'
import type { Node, Edge } from './spec/schema'

function makeNodes(ids: string[]): Node[] {
  return ids.map(id => ({ id, type: 'transform' as const, mode: 'mapping' as const }))
}

function direct(from: string, to: string): Edge {
  return { type: 'direct', from, to }
}

describe('FlowGraph', () => {
  it('topo sort on 5-node linear chain returns nodes in dependency order', () => {
    const nodes = makeNodes(['a', 'b', 'c', 'd', 'e'])
    const edges: Edge[] = [direct('a', 'b'), direct('b', 'c'), direct('c', 'd'), direct('d', 'e')]
    const graph = new FlowGraph(nodes, edges)
    const order = graph.topoOrder()
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('e'))
  })

  it('topo sort on diamond (fork-then-join) returns valid order where fork precedes join', () => {
    const nodes = makeNodes(['root', 'left', 'right', 'join'])
    const edges: Edge[] = [
      direct('root', 'left'), direct('root', 'right'),
      direct('left', 'join'), direct('right', 'join'),
    ]
    const graph = new FlowGraph(nodes, edges)
    const order = graph.topoOrder()
    expect(order.indexOf('root')).toBeLessThan(order.indexOf('join'))
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('join'))
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('join'))
  })

  it('root nodes correctly identified as nodes with no predecessors', () => {
    const nodes = makeNodes(['a', 'b', 'c'])
    const edges: Edge[] = [direct('a', 'b'), direct('b', 'c')]
    const graph = new FlowGraph(nodes, edges)
    expect(graph.roots()).toEqual(['a'])
  })

  it('leaf nodes correctly identified as nodes with no successors', () => {
    const nodes = makeNodes(['a', 'b', 'c'])
    const edges: Edge[] = [direct('a', 'b'), direct('b', 'c')]
    const graph = new FlowGraph(nodes, edges)
    expect(graph.leaves()).toEqual(['c'])
  })

  it('throws GraphCycleError with both offending nodeIds on cycle', () => {
    const nodes = makeNodes(['a', 'b', 'c'])
    const edges: Edge[] = [direct('a', 'b'), direct('b', 'c'), direct('c', 'a')]
    expect(() => new FlowGraph(nodes, edges)).toThrow(GraphCycleError)
    try {
      new FlowGraph(nodes, edges)
    } catch (err) {
      expect(err).toBeInstanceOf(GraphCycleError)
      const cycleErr = err as GraphCycleError
      expect(cycleErr.cycleNodeIds.length).toBeGreaterThan(0)
    }
  })

  it('disconnected subgraph raises FlowExecutionError at construction time', () => {
    const nodes = makeNodes(['a', 'b', 'orphan'])
    const edges: Edge[] = [direct('a', 'b')]
    expect(() => new FlowGraph(nodes, edges)).toThrow(FlowExecutionError)
    expect(() => new FlowGraph(nodes, edges)).toThrow('disconnected')
  })

  it('successors returns outgoing neighbor ids', () => {
    const nodes = makeNodes(['a', 'b', 'c'])
    const edges: Edge[] = [direct('a', 'b'), direct('a', 'c')]
    const graph = new FlowGraph(nodes, edges)
    expect(graph.successors('a').sort()).toEqual(['b', 'c'])
  })

  it('predecessors returns incoming neighbor ids', () => {
    const nodes = makeNodes(['a', 'b', 'c'])
    const edges: Edge[] = [direct('a', 'c'), direct('b', 'c')]
    const graph = new FlowGraph(nodes, edges)
    expect(graph.predecessors('c').sort()).toEqual(['a', 'b'])
  })

  it('getNode returns the node for a known id and undefined for unknown', () => {
    const nodes = makeNodes(['x', 'y'])
    const edges: Edge[] = [direct('x', 'y')]
    const graph = new FlowGraph(nodes, edges)
    expect(graph.getNode('x')?.id).toBe('x')
    expect(graph.getNode('z')).toBeUndefined()
  })
})
