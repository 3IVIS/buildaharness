import { VizNode } from './types.js';
/** Above this many nodes the picture is not useful in a terminal; callers fall back to the checklist. */
export declare const MAX_PLAN_NODES = 150;
/** Dense plans (hundreds of dependencies) turn into a wall of lines; same checklist fallback as the node cap. */
export declare const MAX_PLAN_EDGES = 600;
export declare const BOX_HEIGHT = 3;
/** A box (real) or a one-column waypoint of an edge that skips ranks (virtual). */
export interface LayoutItem {
    uid: number;
    rank: number;
    x: number;
    w: number;
    virtual: boolean;
    /** Real items only. */
    node?: VizNode;
    /** Visible label text of a real item (sanitized and shortened). */
    label?: string;
    /** Virtual items: the chain they belong to, so adjacent-rank waypoints of one edge may share a column. */
    chain?: number;
}
export interface EdgeChain {
    from: string;
    to: string;
    /** Source box, waypoints in rank order, target box. */
    items: LayoutItem[];
}
export interface PlanLayout {
    ok: true;
    nodes: VizNode[];
    ranks: LayoutItem[][];
    chains: EdgeChain[];
    byId: Map<string, LayoutItem>;
    width: number;
    warnings: string[];
}
export type LayoutFailure = {
    ok: false;
    reason: 'empty' | 'too_large' | 'cannot_draw';
    message: string;
};
export declare const LABEL_FLOOR = 8;
/**
 * Layered layout in character units. dagre decides the ranks and the left-to-right order (dummy nodes
 * included); positions are then legalized per rank so boxes never touch and waypoints keep clear of boxes.
 * Deterministic: nodes and edges are inserted in task order and nothing in the input depends on status, so
 * a status change never moves a box.
 */
export declare function layoutPlan(input: readonly VizNode[], labelMax: number): PlanLayout | LayoutFailure;
