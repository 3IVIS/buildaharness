import { Box, Edge, VizNode } from './types.js';
/**
 * The navigation specification and its oracles. `referenceNavigator` is the *executable specification*
 * of the pane's keys (section 5.4 of the plan); the production navigator must behave identically on the
 * property suite below. It was derived from the V10 simulation, where the obvious rule ("go to the
 * nearest connected node") stranded nodes in about 1.1–1.5% of plans and the final rule reached every
 * node in 3,000 of 3,000.
 *
 * Rules:
 *  - ↑ / ↓ follow edges to the nearest (by horizontal position) dependency / dependent. Pressing the SAME
 *    key again cycles through the other candidates of the node the sequence started from.
 *  - ← / → move to the neighbour in the same rank (by horizontal position), wrapping around.
 *  - Tab / Shift+Tab step through all nodes in task order, wrapping — a guaranteed way to reach any node.
 *  - A key with nothing to move to leaves the selection unchanged.
 */
export type NavKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'shiftTab';
export interface NavModel {
    ids: string[];
    /** Task order, used by Tab (usually the plan's own order). */
    taskOrder: string[];
    /** Box centre x and top y; rank is decided by y (equal y = same rank). */
    x: Record<string, number>;
    y: Record<string, number>;
    deps: Record<string, string[]>;
    dependents: Record<string, string[]>;
}
export interface NavState {
    cur: string;
    lastKey?: NavKey;
    /** For a repeated vertical key: the node the cycling started from. */
    lastFrom?: string;
    /** How many times the same vertical key has been repeated. */
    k: number;
}
export interface Navigator {
    start(model: NavModel, id: string): NavState;
    press(model: NavModel, state: NavState, key: NavKey): NavState;
}
export declare function navModelFrom(nodes: readonly VizNode[], boxes: readonly Box[]): NavModel;
export declare const referenceNavigator: Navigator;
/** Every node reachable from `startId` using only the four arrow keys (explores real key state, with repeats). */
export declare function reachableByArrows(nav: Navigator, m: NavModel, startId: string): Set<string>;
/** Arrow-only reachability: every node of a connected plan is reachable from the start node. */
export declare function checkReachability(nav: Navigator, m: NavModel, startId?: string): string[];
/** Tab visits every node once in task order and returns to the start; Shift+Tab is its exact inverse. */
export declare function checkTabCycle(nav: Navigator, m: NavModel): string[];
/** A vertical key with no candidate leaves the selection (and state) untouched. */
export declare function checkBoundaries(nav: Navigator, m: NavModel): string[];
/** ← and → stay in the rank, wrap, and are inverses of each other. */
export declare function checkHorizontal(nav: Navigator, m: NavModel): string[];
/** Repeating ↓ (↑) visits each dependent (dependency) exactly once, then wraps. */
export declare function checkRepeatCycles(nav: Navigator, m: NavModel): string[];
/** The highlighted edges for a selection are exactly the edges touching that node. */
export declare function checkHighlightIncident(m: NavModel, edges: readonly Edge[], highlight: (id: string) => readonly Edge[]): string[];
export interface Viewport {
    left: number;
    top: number;
    width: number;
    height: number;
}
/**
 * Executable specification for panning: keep the selected box fully visible when it fits, never leave
 * the diagram, and never exceed the terminal. Scrolls the minimum amount from the previous viewport so the
 * picture does not jump while navigating.
 */
export declare function followSelection(prev: Viewport, box: Box, grid: {
    width: number;
    height: number;
}, term: {
    cols: number;
    rows: number;
}): Viewport;
export declare function checkViewport(v: Viewport, box: Box, grid: {
    width: number;
    height: number;
}, term: {
    cols: number;
    rows: number;
}): string[];
