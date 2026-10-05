import type { Box } from './types.js'

export interface Viewport {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Keeps the selected box fully visible when it fits, never leaves the diagram and never exceeds the terminal.
 * Scrolls the minimum amount from the previous viewport so the picture does not jump while navigating.
 * Same behaviour as `followSelection` in testkit/nav-oracles.ts (copied: production code does not import the kit).
 */
export function followSelection(prev: Viewport, box: Box, grid: { width: number; height: number }, term: { cols: number; rows: number }): Viewport {
  const width = Math.min(term.cols, grid.width)
  const height = Math.min(term.rows, grid.height)
  const fit = (start: number, size: number, bStart: number, bSize: number, total: number): number => {
    let s = start
    if (bStart < s) s = bStart
    if (bStart + bSize > s + size) s = bStart + bSize - size
    return Math.max(0, Math.min(s, total - size))
  }
  return { width, height, left: fit(prev.left, width, box.x, box.w, grid.width), top: fit(prev.top, height, box.y, box.h, grid.height) }
}

/** Which edges of the diagram lie beyond the viewport, for scroll indicators. */
export function scrollIndicators(v: Viewport, grid: { width: number; height: number }): { up: boolean; down: boolean; left: boolean; right: boolean } {
  return { up: v.top > 0, down: v.top + v.height < grid.height, left: v.left > 0, right: v.left + v.width < grid.width }
}
