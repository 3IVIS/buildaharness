/**
 * The outline of the text as it is now: the headings with their numbers. Drawn from the text itself (not from saved sections), so it follows the
 * writer while typing, and a heading renamed in the outline is a change of the text, which is where the heading lives.
 */
export interface OutlineEntry {
    /** "1", "1.2", … Empty for the title (a single top-level heading at the start). */
    number: string;
    heading: string;
    level: number;
    /** Depth below the title, 0 for the top. */
    depth: number;
    /** Where the heading line starts in the text. */
    start: number;
    /** Where the section ends: just before the next heading of any level. */
    end: number;
}
export declare function outlineOf(markdown: string): OutlineEntry[];
/** The text with the heading line that starts at `start` given a new wording; its level (the hashes) is kept. Unchanged when the new wording is empty. */
export declare function renameHeadingInText(markdown: string, start: number, heading: string): string;
/** The outline as plain text the writer edits: one heading per line, written the way it is in the article (`## Name`). */
export declare function outlineToText(markdown: string): string;
/**
 * The article after the writer edited its outline as text. A heading kept as it was keeps its section; a heading reworded or moved to another
 * level keeps its section too (matched in order, within the gap between unchanged headings); a heading moved to another place takes its section
 * with it; a new line is a new, empty section; a deleted line removes the heading only, its text stays with the section above. Returns the
 * article unchanged while a line is only hashes.
 */
export declare function applyOutlineText(markdown: string, outlineText: string): string;
/**
 * Growing a selection in the outline text: the heading line, then that heading with the headings under it, then the heading it sits under with
 * everything under that, and so on up. The whole outline is never offered, so the largest selection is the one just below it. `range` is in the
 * outline text (`outlineToText`), not in the article.
 */
export declare function expandOutlineSelection(outlineText: string, range: {
    start: number;
    end: number;
}): {
    range: {
        start: number;
        end: number;
    };
    unit: 'heading' | 'section';
} | undefined;
