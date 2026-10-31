import { Box, Edge, RenderResult, VizNode } from './types.js';
export interface OracleOptions {
    /** The diagram uses the ASCII glyph set (`| - + v`). `+` is ambiguous, so edge checks become connectivity-only. */
    ascii?: boolean;
    /** Require reached = expected exactly (default true; forced off for ASCII). */
    exact?: boolean;
    /** Treat `┼` as a junction (turns allowed). Default false: a crossing is straight-through only. */
    crossingIsJunction?: boolean;
}
/** Exactness: from every node, following drawn lines reaches precisely the nodes that depend on it. */
export declare function checkEdges(lines: readonly string[], boxes: readonly Box[], edges: readonly Edge[], opts?: OracleOptions): string[];
/** Line glyphs outside every box that no edge traversal passes through: leftovers such as the prototype's stray segments. */
export declare function checkNoStrays(lines: readonly string[], boxes: readonly Box[], opts?: OracleOptions): string[];
/** Every arrowhead must sit directly above the top border of some box. */
export declare function checkArrowsPointAtBoxes(lines: readonly string[], boxes: readonly Box[], opts?: OracleOptions): string[];
/** No two boxes overlap, and boxes in the same rows keep at least `minGap` empty columns between them. */
export declare function checkNoOverlap(boxes: readonly Box[], minGap?: number): string[];
/** Edge direction: a dependent is drawn strictly below the node it depends on. */
export declare function checkRanksDownward(boxes: readonly Box[], edges: readonly Edge[]): string[];
/** Borders are intact and nothing but label text sits inside a box. */
export declare function checkBoxesDrawn(lines: readonly string[], boxes: readonly Box[], opts?: OracleOptions): string[];
/** Each node's label text (already truncated by the renderer, if it truncates) appears inside its own box. */
export declare function checkLabelsVisible(lines: readonly string[], boxes: readonly Box[], expected: Readonly<Record<string, string>>): string[];
/** No output line is wider than the terminal, measured in cells (CJK and emoji count as two). */
export declare function checkWidth(lines: readonly string[], maxCols: number): string[];
/** Output must be plain printable text: no stray control characters or newlines inside a line. */
export declare function checkPrintable(lines: readonly string[]): string[];
export interface RenderCheckInput {
    render: RenderResult;
    nodes: readonly VizNode[];
    /** Terminal width the render was asked for; width is only checked when given. */
    maxCols?: number;
    /** Expected visible label text per node id (after any truncation); omit to skip. */
    labels?: Readonly<Record<string, string>>;
    opts?: OracleOptions;
}
/** Runs every grid oracle and returns all violations (empty = the diagram is correct). */
export declare function checkRender({ render, maxCols, labels, opts }: RenderCheckInput): string[];
