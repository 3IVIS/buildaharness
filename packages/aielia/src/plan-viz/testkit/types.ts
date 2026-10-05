/**
 * Shared types for the plan-visualization test kit. The kit contains fixtures, seeded generators and
 * *oracles* (independent correctness checkers) that the layout, rasterizer, navigation and pane tests all
 * use, so every layer is held to the same definition of "correct". Nothing here is production code and
 * nothing here is exported from the package index.
 */

export { VIZ_STATUSES } from '../types.js'
export type { VizStatus, VizNode, Box, Edge, RenderResult } from '../types.js'
