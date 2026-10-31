/**
 * An intentionally simple, independent terminal cell-width function for the oracles. The production
 * renderer may use a library; checking it against this separate implementation catches width bugs in
 * either (CJK, emoji, combining marks). Covers the ranges that matter for plan labels, not all of Unicode.
 */
export declare function cellWidth(ch: string): 0 | 1 | 2;
export declare function displayWidth(s: string): number;
/** Marks the second cell of a double-width character in a cell grid. */
export declare const WIDE_TAIL = "\0";
/** Expands a line into one entry per terminal cell (a wide character becomes [char, WIDE_TAIL]). */
export declare function toCells(line: string): string[];
export declare function toGrid(lines: readonly string[]): string[][];
