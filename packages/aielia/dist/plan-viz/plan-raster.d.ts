import { LayoutFailure } from './plan-layout.js';
import { RenderResult, VizNode, VizStatus } from './types.js';
export interface PlanRenderOptions {
    /** Terminal width in cells; labels shrink (down to a floor) until the picture fits. Omit for the natural size. */
    maxCols?: number;
    ascii?: boolean;
    color?: boolean;
    selectedId?: string;
}
/** What a successful render returns beyond what the grid oracles need. */
export interface PlanRender extends RenderResult {
    ok: true;
    width: number;
    height: number;
    /** False when even the shortest labels do not fit `maxCols`; the caller pans a viewport over the full grid. */
    fits: boolean;
    /** The label text each box shows (after sanitizing and shortening). */
    labels: Record<string, string>;
    /** Cells (row, column) every edge is drawn through, keyed `${from}>${to}`. */
    routes: Record<string, Array<[number, number]>>;
    /** One entry per terminal cell (a double-width character is followed by WIDE_TAIL) and its SGR parameters ('' = none). */
    cells: string[][];
    styles: string[][];
    warnings: string[];
}
export type PlanRenderFailure = LayoutFailure;
export declare const GLYPHS: Record<VizStatus, string>;
export declare const ASCII_GLYPHS: Record<VizStatus, string>;
/** Joins cells into text lines, emitting SGR sequences only where the style changes. Trailing blanks are dropped. */
export declare function toLines(cells: readonly string[][], styles: readonly string[][], rows?: [number, number], cols?: [number, number]): string[];
/**
 * Lays out and draws a plan. Labels shrink (down to a floor) until the picture fits `maxCols`; when it still
 * does not, the full-size grid is returned with `fits: false` so the caller can pan over it. Never throws:
 * a plan that cannot be drawn comes back as `{ ok: false, reason, message }` and the caller shows the checklist.
 */
export declare function renderPlan(nodes: readonly VizNode[], opts?: PlanRenderOptions): PlanRender | PlanRenderFailure;
