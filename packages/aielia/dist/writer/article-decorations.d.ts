import { ArticleMeta } from './article-model.js';
import { MarkTone } from './article-marks.js';
/**
 * Everything the page shows inside the text, as pieces of the text with what applies to each: the tint of a claim's sentence (green, orange or
 * red), a dotted underline where an open comment sits, a dashed underline where a suggested change would go, and a mark on a heading whose section
 * needs review. Only styling that does not move the text is possible (the marks are drawn on a copy behind the text area), so detail is not shown
 * here: the box under the text and the line "Here:" say what is at the cursor. Pure; a decoration is drawn only where the stored text still
 * stands at the stored place, so text typed since the last save never gets a mark in the wrong place.
 */
export interface TextPiece {
    start: number;
    end: number;
    /** The worst claim tone over this piece, when it is inside a claim's sentence. */
    tone?: MarkTone;
    claimId?: string;
    claimStatus?: string;
    commentIds: string[];
    suggestionIds: string[];
    reviewSectionId?: string;
}
export declare function textPieces(meta: ArticleMeta, markdown: string): TextPiece[];
/** What applies at one place in the text, in a short line the page shows under it; undefined when nothing does. */
export declare function describeAt(pieces: readonly TextPiece[], position: number): string | undefined;
