import { Box, Edge, VizNode, VizStatus } from './types.js';
/** Small deterministic PRNG (mulberry32): the same seed always yields the same plans, so failures reproduce. */
export declare function rng(seed: number): () => number;
export declare function edgesOf(nodes: readonly VizNode[]): Edge[];
export declare function dependentsOf(nodes: readonly VizNode[]): Record<string, string[]>;
export declare function isAcyclic(nodes: readonly VizNode[]): boolean;
/** Weakly connected: ignoring edge direction, every node can reach every other. */
export declare function isConnected(nodes: readonly VizNode[]): boolean;
/** Longest-path rank from the roots (roots are rank 0). Assumes an acyclic, normalized plan. */
export declare function ranksOf(nodes: readonly VizNode[]): Record<string, number>;
/** Adds a goal node that depends on every sink — exactly what the production adapter does, so the result is connected. */
export declare function withGoal(nodes: readonly VizNode[], goalId?: string, label?: string): VizNode[];
export declare function withStatus(nodes: readonly VizNode[], id: string, status: VizStatus): VizNode[];
export interface Normalized {
    nodes: VizNode[];
    warnings: string[];
}
/**
 * Executable specification of input sanitising: drops duplicate ids (first wins), unknown and self
 * dependencies, and breaks cycles by removing the edge that closes one (deterministically, in input order).
 * The production adapter/layout must satisfy `checkNormalized` on every input, malformed ones included.
 */
export declare function normalizePlan(input: readonly VizNode[]): Normalized;
export declare function checkNormalized(nodes: readonly VizNode[]): string[];
/**
 * A trivial deterministic layout (longest-path ranks, input order within a rank). It is *not* the
 * production layout; it exists so navigation and viewport oracles can be tested before that layout
 * exists, and as a cross-check afterwards. Box height is 3, label width is the display width.
 */
export declare function toyLayout(plan: readonly VizNode[], gapX?: number, gapY?: number): {
    boxes: Box[];
    edges: Edge[];
    width: number;
    height: number;
};
/** The 9-task plan used throughout the verification work, every interesting status included, goal depending on the terminals. */
export declare const NINE_TASK_PLAN: VizNode[];
/** Hand-shaped plans, each chosen to stress one thing. Every one is normalized; `connected` says whether it is weakly connected. */
export declare const NAMED_PLANS: Record<string, {
    nodes: VizNode[];
    connected: boolean;
}>;
/**
 * The seven real plan templates shipped with aielia, converted to nodes with a goal node added
 * (what a user of the product actually gets). Statuses are assigned by progress so each one exercises
 * done / running / pending.
 */
export declare function templatePlans(): Record<string, VizNode[]>;
export interface RandomPlanOptions {
    minNodes?: number;
    maxNodes?: number;
    /** Probability that a node depends on any given earlier node (default depends on size). */
    density?: number;
    /** Add a goal depending on every sink (connected, like the adapter's output). Default true. */
    goal?: boolean;
    /** Mix in CJK and very long labels. Default false. */
    unicodeLabels?: boolean;
}
export declare function randomPlan(seed: number, opts?: RandomPlanOptions): VizNode[];
/** Malformed inputs the production code must survive (it receives LLM-drafted and hand-edited plans). */
export declare const MALFORMED_PLANS: Record<string, VizNode[]>;
