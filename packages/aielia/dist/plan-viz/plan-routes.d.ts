import { PlanRender } from './plan-raster.js';
import { Edge } from './types.js';
/** The edges that touch a node: its incoming (dependencies) and outgoing (dependents) ones. */
export declare function incidentEdges(edges: readonly Edge[], id: string): Edge[];
/** Every cell the incident edges of `id` are drawn through, as `"row,col"` keys (exact: the rasterizer reports its own routes). */
export declare function highlightCells(render: Pick<PlanRender, 'edges' | 'routes'>, id: string): Set<string>;
