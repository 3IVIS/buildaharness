/**
 * Shared types for the plan-visualization test kit. The kit contains fixtures, seeded generators and
 * *oracles* (independent correctness checkers) that the layout, rasterizer, navigation and pane tests all
 * use, so every layer is held to the same definition of "correct". Nothing here is production code and
 * nothing here is exported from the package index.
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
