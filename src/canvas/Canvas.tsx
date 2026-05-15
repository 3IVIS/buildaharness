import { useCallback } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, BackgroundVariant,
  type Node, type NodeMouseHandler, type EdgeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCanvasStore } from '../store'
import { nodeTypes } from './nodes'
import { edgeTypes } from './edges'

export function Canvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, selectNode, selectEdge, addNode } = useCanvasStore()

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }, [])
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/itsharness-node')
    if (!type) return
    const canvas = e.currentTarget.getBoundingClientRect()
    addNode(type as never, { x: e.clientX - canvas.left - 100, y: e.clientY - canvas.top - 24 })
  }, [addNode])

  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => selectNode(node.id), [selectNode])
  const onEdgeClick: EdgeMouseHandler = useCallback((_e, edge) => selectEdge(edge.id), [selectEdge])
  const onPaneClick = useCallback(() => { selectNode(null); selectEdge(null) }, [selectNode, selectEdge])

  return (
    <div className="canvas-area" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes as Node[]}
        edges={edges}
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
        defaultEdgeOptions={{ type: 'direct', markerEnd: { type: 'arrowclosed', width: 12, height: 12, color: '#52526a' } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => ({
            input: '#3b82f6', output: '#6b7280', llm_call: '#8b5cf6',
            tool_invoke: '#14b8a6', condition: '#f59e0b',
            parallel_fork: '#22c55e', parallel_join: '#16a34a',
            hitl_breakpoint: '#f97316', memory_read: '#06b6d4',
            memory_write: '#0891b2', subgraph: '#64748b',
            transform: '#a855f7', agent_role: '#ec4899', agent_debate: '#d946ef',
          })[n.type ?? ''] ?? '#52526a'}
          maskColor="rgba(12,12,14,0.7)"
        />
      </ReactFlow>
    </div>
  )
}
