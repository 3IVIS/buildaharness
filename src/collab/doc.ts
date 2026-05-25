/**
 * collab/doc.ts
 *
 * Defines the shape of the shared Yjs document and the factory that creates it.
 *
 * Y.Doc layout
 * ────────────
 *  nodes    Y.Map<Y.Map<unknown>>   keyed by node id → { type, position, data }
 *  edges    Y.Map<Y.Map<unknown>>   keyed by edge id → { source, target, type, data }
 *  flowMeta Y.Map<unknown>          mirrors FlowMeta fields flat
 *
 * Using Y.Map<Y.Map> (rather than Y.Array) for nodes/edges means individual
 * field updates don't retransmit the whole collection — important once flows
 * have dozens of nodes.
 */
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'

export interface CollabDoc {
  doc:        Y.Doc
  /** nodeId → { id, type, position, data } */
  nodes:      Y.Map<Y.Map<unknown>>
  /** edgeId → { id, source, target, type, data } */
  edges:      Y.Map<Y.Map<unknown>>
  /** Mirrors FlowMeta (id, name, description, runtimeHints) */
  flowMeta:   Y.Map<unknown>
  /** Per-user cursor position + identity */
  awareness:  Awareness
  /**
   * The active WebsocketProvider — set by ItsHarnessCanvas after connecting.
   * Null until the async setup completes.
   */
  wsProvider: WebsocketProvider | null
}

export function createCollabDoc(): CollabDoc {
  const doc      = new Y.Doc()
  const nodes    = doc.getMap<Y.Map<unknown>>('nodes')
  const edges    = doc.getMap<Y.Map<unknown>>('edges')
  const flowMeta = doc.getMap<unknown>('flowMeta')
  const awareness = new Awareness(doc)

  return { doc, nodes, edges, flowMeta, awareness, wsProvider: null }
}
