import { Box, VizNode } from './types.js';
/**
 * Keyboard navigation over the plan graph (section 5.4). Same behaviour as `referenceNavigator` in
 * testkit/nav-oracles.ts (copied: production code does not import the kit); a differential test keeps them equal.
 * Pure: no I/O. Read-only: it only moves a selection.
 */
export type NavKey = 'up' | 'down' | 'left' | 'right' | 'tab' | 'shiftTab';
export interface NavModel {
    ids: string[];
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
    k: number;
}
export interface Navigator {
    start(model: NavModel, id: string): NavState;
    press(model: NavModel, state: NavState, key: NavKey): NavState;
}
export declare function navModelFrom(nodes: readonly VizNode[], boxes: readonly Box[]): NavModel;
export declare const planNavigator: Navigator;
