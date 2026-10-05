/**
 * Production types for the plan visualization: the status vocabulary the renderers receive, the node
 * shape the layout consumes, and what a rasterizer returns. The test kit re-exports these so there is
 * one definition.
 */

/** The status vocabulary the renderer receives (the adapter maps aielia TaskStatus onto it). */
export type VizStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'awaiting_user' | 'awaiting_input' | 'cancelled'

export const VIZ_STATUSES: readonly VizStatus[] = ['pending', 'ready', 'running', 'done', 'failed', 'awaiting_user', 'awaiting_input', 'cancelled']

export interface VizNode {
  id: string
  label: string
  status: VizStatus
  /** Ids this node depends on (they are drawn above it). */
  deps: string[]
}

/** A node rectangle on the character grid, in cells (a double-width character occupies two cells). */
export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** `from` is the dependency (drawn above), `to` the dependent (drawn below). */
export interface Edge {
  from: string
  to: string
}

/** What a rasterizer must return for the oracles to be able to check it. */
export interface RenderResult {
  lines: string[]
  boxes: Box[]
  edges: Edge[]
}
