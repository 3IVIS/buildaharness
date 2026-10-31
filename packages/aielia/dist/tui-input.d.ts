/**
 * One word-wrapped visual row of the draft. `wraps: true` means the next row is a continuation
 * of the same logical (`\n`-delimited) line — no real newline between `end` and the next row's
 * `start` — which is what lets {@link offsetToRowCol} tell a wrap boundary (cursor snaps to the
 * start of the next row) apart from a real end-of-line (cursor stays put at this row's end).
 */
export interface DraftRow {
    text: string;
    start: number;
    end: number;
    wraps: boolean;
}
/**
 * Splits `value` into visual rows at `\n` boundaries and, within each logical line, at every
 * `columns`-wide chunk — plain character wrapping (not word-boundary wrapping): a real terminal
 * hard-wraps by character when a row overflows, so this matches what the terminal will actually
 * show rather than reflowing at word boundaries the way a GUI text area would.
 */
export declare function wrapDraftIntoRows(value: string, columns: number): DraftRow[];
/** Maps a character offset into `value` to its (row, col) among `rows` — see {@link DraftRow.wraps} for the wrap-vs-newline distinction this leans on. */
export declare function offsetToRowCol(rows: DraftRow[], cursor: number): {
    row: number;
    col: number;
};
/** Inverse of {@link offsetToRowCol}, clamping both row and column into range — used to preserve column when moving the cursor a visual row up/down. */
export declare function rowColToOffset(rows: DraftRow[], row: number, col: number): number;
/** Home = start of the current logical (`\n`-delimited) line, not the current visual row. */
export declare function homeOffset(value: string, cursor: number): number;
/** End = end of the current logical (`\n`-delimited) line, not the current visual row. */
export declare function endOffset(value: string, cursor: number): number;
/**
 * Keeps the cursor's row inside a `maxRows`-tall window, scrolling the minimum amount needed —
 * matches an ordinary scrolling textarea rather than re-centering on every keystroke.
 */
export declare function computeViewportStart(prevStart: number, cursorRow: number, totalRows: number, maxRows: number): number;
export interface TuiInputProps {
    /** Question text for a pending askYesNo/askLine prompt (Decision 1's override seam) — undefined means ordinary chat mode. Shown as a label above the box, since it's real information (the question being asked), unlike chat mode's old static "you" label, which was dropped in favor of a placeholder inside the box (see `placeholder` below). */
    promptLabel?: string;
    /** Faint placeholder shown inside the (empty) box in chat mode, replacing the old "you" label above it. */
    placeholder?: string;
    /** Called when Enter submits a non-empty draft in chat mode. Also appended to in-session history. */
    onSubmitChat: (line: string) => void;
    /** Called when Enter resolves a pending prompt (promptLabel set). Not added to chat history. */
    onSubmitPrompt: (line: string) => void;
    /** Terminal width; defaults to the live width from Ink's useWindowSize. Pass explicitly for a deterministic wrap width in tests. */
    columns?: number;
    /** Max input box height in rows before internal scrolling kicks in. */
    maxRows?: number;
    isActive?: boolean;
}
export declare function TuiInput(props: TuiInputProps): React.JSX.Element;
