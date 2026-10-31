/**
 * Terminal cell widths for the plan renderer. Same tables as testkit/display-width.ts (copied, not imported: production code must not depend on the test kit);
 * the oracles cross-check it against that independent copy. Covers the ranges that matter for plan labels, not all of Unicode.
 */
export declare function cellWidth(ch: string): 0 | 1 | 2;
export declare function displayWidth(s: string): number;
/** Marks the second cell of a double-width character in a cell grid. */
export declare const WIDE_TAIL = "\0";
/** Expands a line into one entry per terminal cell (a wide character becomes [char, WIDE_TAIL]). */
export declare function toCells(line: string): string[];
export declare function toGrid(lines: readonly string[]): string[][];
/** One printable line: control, escape and bidi characters are removed, whitespace runs collapse, ends are trimmed. */
export declare function sanitizeLabel(raw: string): string;
/** Cuts `s` to at most `max` cells, ending with an ellipsis when something was removed. Never splits a wide character. */
export declare function fitLabel(s: string, max: number): string;
