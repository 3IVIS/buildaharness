/**
 * collab/syncToYjs.ts
 *
 * Called from a store.subscribe() listener in App.tsx (collab setup).
 * Converts Zustand state diffs into Yjs mutations.
 *
 * All writes are wrapped in doc.transact() so that a single user action
 * (e.g. insert-node-on-edge: add node + add 2 edges + remove 1 edge) is
 * sent as a single Yjs update rather than 4 separate broadcasts.
 *
 * The isSyncing() guard prevents echo-loops: when syncFromYjs.ts is writing
 * remote changes into the store, that triggers this subscriber — we skip it.
 *
 * Position/data are compared via JSON.stringify to avoid redundant Yjs writes
 * caused by object reference inequality (the Yjs Y.Map always returns a fresh
 * object on get(), so === would always be true and would re-write every field
 * on every node update, generating excessive network traffic during drags).
 *
 * syncMetaMap also purges stale keys from the Y.Map so that fields removed
 * from FlowMeta in the local state are deleted from the shared doc (Fix #2).
 */
import * as Y from 'yjs'
import type { Edge as XYEdge } from '@xyflow/react'
import type { CanvasNode, CanvasStore } from '../store'
import type { CollabDoc } from './doc'

// The slice of CanvasStore that collab syncs.
type CollabStateSlice = Pick<CanvasStore, 'nodes' | 'edges' | 'flowMeta'>

export function syncStoreToYjs(
  state:     CollabStateSlice,
  prev:      Partial<CollabStateSlice>,
  collab:    CollabDoc,
  isSyncing: () => boolean,
): void {
  if (isSyncing()) return

  const hasNodeChange = state.nodes    !== prev.nodes
  const hasEdgeChange = state.edges    !== prev.edges
  const hasMetaChange = state.flowMeta !== prev.flowMeta

  if (!hasNodeChange && !hasEdgeChange && !hasMetaChange) return

  collab.doc.transact(() => {
    if (hasNodeChange) syncNodesMap(state.nodes, collab.nodes)
    if (hasEdgeChange) syncEdgesMap(state.edges, collab.edges)
    if (hasMetaChange) syncMetaMap(state.flowMeta, collab.flowMeta)
  })
}

/**
 * Push the full current store state into Yjs unconditionally.
 * Call this once after connecting to seed an empty Yjs doc from localStorage.
 */
export function seedYjsFromStore(state: CollabStateSlice, collab: CollabDoc): void {
  collab.doc.transact(() => {
    syncNodesMap(state.nodes, collab.nodes)
    syncEdgesMap(state.edges, collab.edges)
    syncMetaMap(state.flowMeta, collab.flowMeta)
  })
}

// ─── Sync helpers ─────────────────────────────────────────────────────────────

function syncNodesMap(
  nodes:  CanvasNode[],
  yNodes: Y.Map<Y.Map<unknown>>,
): void {
  const currentIds = new Set(nodes.map((n) => n.id))

  // Remove deleted nodes
  yNodes.forEach((_, id) => {
    if (!currentIds.has(id)) yNodes.delete(id)
  })

  for (const node of nodes) {
    let yNode = yNodes.get(node.id)
    if (!yNode) {
      yNode = new Y.Map<unknown>()
      yNodes.set(node.id, yNode)
    }

    // type: string — simple equality
    if (yNode.get('type') !== node.type) yNode.set('type', node.type)

    // position: {x, y} object — compare by value to avoid spurious writes on every drag.
    // yNode.get('position') always returns a fresh object (not the same JS reference),
    // so === would always be false and we'd re-broadcast on every node array update.
    const storedPos = yNode.get('position') as { x: number; y: number } | undefined
    if (!storedPos ||
        storedPos.x !== node.position.x ||
        storedPos.y !== node.position.y) {
      yNode.set('position', node.position)
    }

    // data: arbitrary object — JSON.stringify for deep equality.
    // Slightly more expensive but prevents flooding the WS on config-panel edits
    // where data changes but position doesn't.
    const storedData = yNode.get('data')
    if (JSON.stringify(storedData) !== JSON.stringify(node.data)) {
      yNode.set('data', node.data)
    }
  }
}

function syncEdgesMap(
  edges:  XYEdge[],
  yEdges: Y.Map<Y.Map<unknown>>,
): void {
  const currentIds = new Set(edges.map((e) => e.id))

  yEdges.forEach((_, id) => {
    if (!currentIds.has(id)) yEdges.delete(id)
  })

  for (const edge of edges) {
    let yEdge = yEdges.get(edge.id)
    if (!yEdge) {
      yEdge = new Y.Map<unknown>()
      yEdges.set(edge.id, yEdge)
    }
    if (yEdge.get('source') !== edge.source) yEdge.set('source', edge.source)
    if (yEdge.get('target') !== edge.target) yEdge.set('target', edge.target)
    if (yEdge.get('type')   !== edge.type)   yEdge.set('type',   edge.type)

    // data: deep compare to avoid redundant writes
    const storedData = yEdge.get('data')
    if (JSON.stringify(storedData) !== JSON.stringify(edge.data)) {
      yEdge.set('data', edge.data)
    }
  }
}

function syncMetaMap(
  flowMeta: CollabStateSlice['flowMeta'],
  yMeta:    Y.Map<unknown>,
): void {
  // Remove keys that no longer exist in the local state (e.g. fields dropped in
  // a future refactor). Without this, stale keys accumulate in the Yjs doc and
  // propagate to all peers indefinitely.
  yMeta.forEach((_, k) => {
    if (!(k in flowMeta)) yMeta.delete(k)
  })

  for (const [k, v] of Object.entries(flowMeta)) {
    // Deep compare for nested objects (runtimeHints)
    if (JSON.stringify(yMeta.get(k)) !== JSON.stringify(v)) yMeta.set(k, v)
  }
}
