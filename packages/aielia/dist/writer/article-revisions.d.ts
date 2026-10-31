import { SelectionRange, SelectionUnit } from './article-selection.js';
/**
 * The revisions of one piece of the text (a sentence, a paragraph or a section): how that piece read in each saved version. The piece is the unit
 * the selection is (see `unitOfSelection`). In an older version the same piece is the unit of the same kind that shares the most words with it, so
 * a reworded sentence is still found; when nothing shares enough, the piece was not in that version. Pure; versions come from the article's snapshots.
 */
export interface VersionText {
    index: number;
    kind: string;
    label?: string;
    at: string;
    markdown: string;
}
export interface TextRevision {
    /** The version, or undefined for the text as it is now. */
    index?: number;
    kind?: string;
    label?: string;
    at?: string;
    /** How the piece read then; undefined when it was not in that version. */
    text: string | undefined;
}
export interface TextRevisions {
    unit: SelectionUnit;
    now: string;
    /** Newest first, starting with now, and only where the wording differs from the revision before it. */
    revisions: TextRevision[];
}
/** `versions` in any order. */
export declare function revisionsOfText(markdown: string, range: SelectionRange, versions: readonly VersionText[]): TextRevisions | undefined;
