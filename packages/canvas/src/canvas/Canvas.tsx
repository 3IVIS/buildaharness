import { useCallback, useState, useEffect, useMemo } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, BackgroundVariant,
  useReactFlow,
  type Node, type NodeMouseHandler, type EdgeMouseHandler,
} from '@xyflow/react'
import { useCanvasStore } from '../store/context'
import { nodeTypes } from './nodes'
import { edgeTypes } from './edges'
import { NODE_HEX } from './nodes/BaseNode'
import { RegionLayer } from './regions/RegionLayer'
import { CanvasToolbar } from '../components/CanvasToolbar'
import type { NodeType } from '../spec/schema'

type FocusDepth = 1 | 2 | 'all'

// ── Focus mode ────────────────────────────────────────────────────────────────

function useFocusMode(nodes: Node[], edges: { source: string; target: string }[]) {
  const [focusId, setFocusId]   = useState<string | null>(null)
  const [depth, setDepth]       = useState<FocusDepth>(1)

  function toggle(id: string) {
    setFocusId((prev) => (prev === id ? null : id))
  }
  function clear() { setFocusId(null) }

  const focusedIds: Set<string> = useMemo(() => {
    const result = new Set<string>()
    if (!focusId) return result
    result.add(focusId)
    if (depth === 'all') {
      const adj = new Map<string, Set<string>>()
      for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, new Set())
        if (!adj.has(e.target)) adj.set(e.target, new Set())
        adj.get(e.source)!.add(e.target)
        adj.get(e.target)!.add(e.source)
      }
      const stack = [focusId]
      while (stack.length) {
        const id = stack.pop()!
        for (const n of adj.get(id) ?? []) {
          if (!result.has(n)) { result.add(n); stack.push(n) }
        }
      }
    } else {
      let frontier = new Set([focusId])
      for (let d = 0; d < depth; d++) {
        const next = new Set<string>()
        for (const e of edges) {
          if (frontier.has(e.source) && !result.has(e.target)) next.add(e.target)
          if (frontier.has(e.target) && !result.has(e.source)) next.add(e.source)
        }
        for (const id of next) result.add(id)
        frontier = next
      }
    }
    return result
  }, [focusId, depth, edges])

  return { focusId, focusedIds, depth, setDepth, toggle, clear }
}

function desaturateForMinimap(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luma = (r + g + b) / 3
  const blend = 0.55
  const mx = (c: number) => Math.round(c * blend + luma * (1 - blend))
  const h  = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(mx(r))}${h(mx(g))}${h(mx(b))}`
}

// ── Canvas ────────────────────────────────────────────────────────────────────

export function Canvas() {
  const {
    nodes, edges, onNodesChange, onEdgesChange, onConnect,
    selectNode, selectEdge, addNode, addAnnotation,
  } = useCanvasStore((s) => s)

  const { focusId, focusedIds, depth, setDepth, toggle, clear } = useFocusMode(
    (nodes as Node[]).filter((n) => n.type !== 'annotation'), edges,
  )

  const onNodeClick: NodeMouseHandler = useCallback((e, node) => {
    if (e.shiftKey) {
      e.stopPropagation()
      toggle(node.id)
    } else {
      selectNode(node.id)
    }
  }, [selectNode, toggle])

  const onEdgeClick: EdgeMouseHandler = useCallback((_e, edge) => selectEdge(edge.id), [selectEdge])

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
    clear()
  }, [selectNode, selectEdge, clear])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

      if (e.key === 'Escape' && focusId) {
        e.stopPropagation()
        clear()
        return
      }

      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !inInput) {
        addAnnotation({ x: 300 + Math.random() * 100, y: 200 + Math.random() * 100 })
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [addAnnotation, focusId, clear])

  const displayNodes = focusId
    ? (nodes as Node[]).map((n) => ({
        ...n,
        style: {
          ...n.style,
          opacity: focusedIds.has(n.id) ? 1 : 0.18,
          transition: 'opacity 0.2s',
        },
      }))
    : (nodes as Node[])

  const displayEdges = focusId
    ? edges.map((e) => {
        const inSrc = focusedIds.has(e.source)
        const inTgt = focusedIds.has(e.target)
        const op = inSrc && inTgt ? 1 : (inSrc || inTgt) ? 0.35 : 0.08
        return {
          ...e,
          style: { ...e.style, opacity: op, transition: 'opacity 0.2s' },
        }
      })
    : edges

  return (
    <div className="canvas-area">
      {focusId && (
        <div className="focus-toolbar">
          <span className="focus-toolbar__label">focus · depth</span>
          {([1, 2, 'all'] as FocusDepth[]).map((d) => (
            <button
              key={String(d)}
              onClick={() => setDepth(d)}
              className={`focus-toolbar__btn${depth === d ? ' is-active' : ''}`}
            >
              {d === 'all' ? 'all' : String(d)}
            </button>
          ))}
          <span className="focus-toolbar__sep" />
          <button
            onClick={clear}
            className="focus-toolbar__btn focus-toolbar__close"
            title="Exit focus (Esc, or click canvas)"
          >
            ✕
          </button>
        </div>
      )}
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'direct',
          markerEnd: { type: 'arrowclosed', width: 12, height: 12, color: '#52526a' },
        }}
      >
        <DnDHandler addNode={addNode} />
        <RegionLayer />
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const hex = NODE_HEX[n.type as NodeType]
            return desaturateForMinimap(hex ?? '#52526a')
          }}
          maskColor="rgba(12,12,14,0.7)"
        />
        <CanvasToolbar />
      </ReactFlow>
    </div>
  )
}

// ── DnDHandler ────────────────────────────────────────────────────────────────

function DnDHandler({ addNode }: { addNode: (type: NodeType, pos: { x: number; y: number }) => void }) {
  const { screenToFlowPosition } = useReactFlow()

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/buildaharness-node')
    if (!type) return
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode(type as NodeType, position)
  }, [addNode, screenToFlowPosition])

  return (
    <div
      style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'all' }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  )
}
