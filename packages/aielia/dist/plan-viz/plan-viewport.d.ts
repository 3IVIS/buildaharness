import { Box } from './types.js';
export interface Viewport {
    left: number;
    top: number;
    width: number;
    height: number;
}
/**
 * Keeps the selected box fully visible when it fits, never leaves the diagram and never exceeds the terminal.
 * Scrolls the minimum amount from the previous viewport so the picture does not jump while navigating.
 * Same behaviour as `followSelection` in testkit/nav-oracles.ts (copied: production code does not import the kit).
 */
export declare function followSelection(prev: Viewport, box: Box, grid: {
    width: number;
    height: number;
}, term: {
    cols: number;
    rows: number;
}): Viewport;
/** Which edges of the diagram lie beyond the viewport, for scroll indicators. */
export declare function scrollIndicators(v: Viewport, grid: {
    width: number;
    height: number;
}): {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
};
