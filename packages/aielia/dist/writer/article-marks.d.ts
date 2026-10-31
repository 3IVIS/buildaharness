import { ArticleMeta } from './article-model.js';
/**
 * Where the page tints the text, and in which of three tones. Pure: a claim is marked only where its stored quote still stands at its stored
 * position in the text on screen, so text typed since the last save never gets a tint in the wrong place. The tint covers the whole sentence that
 * holds the claim. Two claims in one sentence share one tint, in the worse tone. Marks never overlap.
 *
 * ok (green): the claim is backed by its source. look (orange): it still needs a source, a check, or a better source (no source, not checked yet,
 * out of date, partly or not backed, or searched for and not found). bad (red): a source says the opposite.
 */
export type MarkTone = 'ok' | 'tried' | 'look' | 'bad';
export interface ClaimMark {
    /** The sentence the tint covers. */
    start: number;
    end: number;
    claimId: string;
    tone: MarkTone;
    /** The status shown to the writer, after the rules for stale and unchecked results. */
    status: string;
}
/** The sentence around a quote: back to the end of the previous sentence or the start of the line, forward to the end punctuation or the end of the line. */
export declare function sentenceAround(text: string, start: number, end: number): {
    start: number;
    end: number;
};
export declare function claimMarks(meta: ArticleMeta, markdown: string): ClaimMark[];
