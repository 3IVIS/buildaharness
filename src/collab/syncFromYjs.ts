/**
 * collab/syncFromYjs.ts
 *
 * Registers Yjs observers that push remote state into the local Zustand store.
 *
 * Rules:
 *  • Only react to remote transactions (transaction.local === false) to avoid
 *    echo-looping our own writes back through the store.
 *  • Write via store.setState() directly — NOT via store actions — so that
 *    remote changes bypass _pushHistory. Per-user undo is handled by
 *    Y.UndoManager (see undoManager.ts).
 *  • Call setSyncing(true/false) around each setState so the outbound
 *    subscriber (syncToYjs.ts) knows to skip those updates. A depth counter
 *    (not a boolean) is used so that when one remote transaction fires multiple
 *    observers (e.g. nodes + edges both changed), the suppress flag stays raised
 *    until ALL observers have finished — preventing a partial-echo between them.
 *  • Preserve transient ReactFlow fields (selected, measured) from the existing
 *    store nodes so local selection state survives remote updates.
 *  • When a remote peer deletes the locally-selected node/edge, close the panel.
 */
import type * as Y from 'yjs'
import type { StoreApi } from 'zustand'
import type { Edge as XYEdge } from '@xyflow/react'
import type { CanvasNode, CanvasStore, FlowMeta } from '../store'
import type { CollabDoc } from './doc'

type AppStoreRef = StoreApi<CanvasStore>

export function bindYjsToStore(
  collab:     CollabDoc,
  store:      AppStoreRef,
  setSyncing: (v: boolean) => void,
): () => void {
  // Use a depth counter rather than a boolean flag so that when a single remote
  // Yjs transaction fires multiple observers (e.g. nodes + edges changed together),
  // the outbound subscriber stays suppressed until ALL observers have finished.
  // With a plain boolean, the flag resets to false after the first observer's
  // finally block, letting the Zustand subscriber fire between observers and
  // echo the partial update back to Yjs.
  let syncDepth = 0

  function beginSync()  { syncDepth++; if (syncDepth === 1) setSyncing(true)  }
  function endSync()    { syncDepth--; if (syncDepth === 0) setSyncing(false) }

  function onNodesChange(_event: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) {
    if (transaction.local) return
    beginSync()
    try {
      // Build a lookup of transient fields from the current store nodes so we
      // can preserve `selected` and `measured` (set by ReactFlow, not stored in Yjs).
      const existing = store.getState().nodes
      // Build lookup of transient ReactFlow fields (not stored in Yjs) so we
      // can restore them after rebuilding nodes from remote state.
      const transient = new Map(existing.map((n) => [n.id, {
        selected: n.selected,
        measured: n.measured,
      }]))

      const nodes: CanvasNode[] = []
      collab.nodes.forEach((yNode, id) => {
        const base = yNodeToCanvasNode(id, yNode)
        const t = transient.get(id)
        if (t) {
          if (t.selected !== undefined) base.selected = t.selected
          if (t.measured !== undefined) base.measured  = t.measured
        }
        nodes.push(base)
      })

      // If the locally-selected node was deleted by a remote peer, close the panel.
      const { selectedNodeId } = store.getState()
      const selectedStillExists = selectedNodeId === null ||
        nodes.some((n) => n.id === selectedNodeId)

      store.setState(
        selectedStillExists
          ? { nodes }
          : { nodes, selectedNodeId: null, isPanelOpen: false },
      )
    } finally {
      endSync()
    }
  }

  function onEdgesChange(_event: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) {
    if (transaction.local) return
    beginSync()
    try {
      const edges: XYEdge[] = []
      collab.edges.forEach((yEdge, id) => {
        edges.push(yEdgeToXYEdge(id, yEdge))
      })

      // If the selected edge was deleted remotely, close its panel.
      const { selectedEdgeId } = store.getState()
      const edgeStillExists = selectedEdgeId === null ||
        edges.some((e) => e.id === selectedEdgeId)

      store.setState(
        edgeStillExists
          ? { edges }
          : { edges, selectedEdgeId: null, isEdgePanelOpen: false },
      )
    } finally {
      endSync()
    }
  }

  function onMetaChange(_event: Y.YMapEvent<unknown>, transaction: Y.Transaction) {
    if (transaction.local) return
    beginSync()
    try {
      const flowMeta = Object.fromEntries(collab.flowMeta) as unknown as FlowMeta
      store.setState({ flowMeta })
    } finally {
      endSync()
    }
  }

  collab.nodes.observe(onNodesChange)
  collab.edges.observe(onEdgesChange)
  collab.flowMeta.observe(onMetaChange)

  return () => {
    collab.nodes.unobserve(onNodesChange)
    collab.edges.unobserve(onEdgesChange)
    collab.flowMeta.unobserve(onMetaChange)
  }
}


/**
 * One-shot snapshot read: push the current Yjs doc state into the Zustand store.
 *
 * Call this after IndexedDB persistence loads and the Yjs doc has existing state,
 * to bring the store in sync before the WS provider connects. Unlike the
 * observer-based approach this doesn't filter on transaction.local — it's a
 * direct read of the current Yjs snapshot.
 *
 * Also recalculates _nodeCounter from the loaded node IDs so that any nodes
 * added after hydration (in solo mode or after collab ends) don't collide with
 * IDs already present in the Yjs document.
 */
export function hydrateStoreFromYjs(
  collab: CollabDoc,
  store:  AppStoreRef,
): void {
  const nodes: CanvasNode[] = []
  collab.nodes.forEach((yNode, id) => nodes.push(yNodeToCanvasNode(id, yNode)))

  const edges: XYEdge[] = []
  collab.edges.forEach((yEdge, id) => edges.push(yEdgeToXYEdge(id, yEdge)))

  // Recalculate _nodeCounter from the highest numeric suffix in any node id.
  // Without this, if a peer has added nodes beyond the local counter,
  // solo-mode addNode() (no clientId suffix) could produce a duplicate id.
  const maxCounter = nodes.reduce((max, n) => {
    const m = n.id.match(/(\d+)(?:-\d+)?$/)
    return m ? Math.max(max, parseInt(m[1], 10)) : max
  }, store.getState()._nodeCounter)

  const updates: Partial<CanvasStore> = { nodes, edges, _nodeCounter: maxCounter }
  if (collab.flowMeta.size > 0) {
    updates.flowMeta = Object.fromEntries(collab.flowMeta) as unknown as FlowMeta
  }
  store.setState(updates)
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function yNodeToCanvasNode(id: string, yNode: Y.Map<unknown>): CanvasNode {
  return {
    id,
    type:     (yNode.get('type') as string) ?? 'default',
    position: (yNode.get('position') as { x: number; y: number }) ?? { x: 0, y: 0 },
    data:     (yNode.get('data') as Record<string, unknown>) ?? {},
  }
}

function yEdgeToXYEdge(id: string, yEdge: Y.Map<unknown>): XYEdge {
  return {
    id,
    source: (yEdge.get('source') as string) ?? '',
    target: (yEdge.get('target') as string) ?? '',
    type:   (yEdge.get('type')   as string) ?? 'direct',
    data:   (yEdge.get('data')   as Record<string, unknown>) ?? {},
  }
}
