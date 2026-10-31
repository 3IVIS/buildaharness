/**
 * Transforms a point from subgraph-local coordinates to parent context coordinates.
 * @param x X in subgraph
 * @param y Y in subgraph
 * @param clusterX X of cluster node in parent
 * @param clusterY Y of cluster node in parent
 * @param subgraphCenterX Center X of subgraph in subgraph coords
 * @param subgraphCenterY Center Y of subgraph in subgraph coords
 * @returns [x, y] in parent context
 */
export declare function toParentCoords(x: number, y: number, clusterX: number, clusterY: number, subgraphCenterX: number, subgraphCenterY: number): [number, number];
/**
 * Transforms a point from parent context coordinates to subgraph-local coordinates.
 * @param x X in parent
 * @param y Y in parent
 * @param clusterX X of cluster node in parent
 * @param clusterY Y of cluster node in parent
 * @param subgraphCenterX Center X of subgraph in subgraph coords
 * @param subgraphCenterY Center Y of subgraph in subgraph coords
 * @returns [x, y] in subgraph-local coords
 */
export declare function toSubgraphCoords(x: number, y: number, clusterX: number, clusterY: number, subgraphCenterX: number, subgraphCenterY: number): [number, number];
import type { Graph } from './types';
export declare function adjust(graph: Graph): void;
export declare function undo(graph: Graph): void;
//# sourceMappingURL=coordinate-system.d.ts.map