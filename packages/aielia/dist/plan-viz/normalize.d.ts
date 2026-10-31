import { VizNode } from './types.js';
export interface NormalizedNodes {
    nodes: VizNode[];
    /** What was repaired, one human-readable line each (duplicate ids, unknown/self dependencies, broken cycles). */
    warnings: string[];
}
/**
 * Makes any node list safe for the layout and rasterizer: drops duplicate ids (first wins), unknown and
 * self dependencies, duplicate dependencies, and breaks cycles by removing the edge that closes one
 * (depth-first in input order, so the result is deterministic). Never throws and never mutates its input.
 * Behaviour is specified by `normalizePlan` in testkit/generators.ts and differential-tested against it.
 * The depth-first walk is iterative so a very deep chain cannot overflow the stack.
 */
export declare function normalizePlanNodes(input: readonly VizNode[]): NormalizedNodes;
