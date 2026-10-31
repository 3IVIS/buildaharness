/**
 * When the page should save a version by itself while the writer types: a sentence has been finished (a full stop, question mark or
 * exclamation mark ends it), a section has been started (a heading line is complete), or the writer has begun changing a different sentence
 * from the one they were editing, which means they are done with that one. Pure: it looks at the text before and after one change.
 */
export interface AutosaveStep {
    /** `after`: save the text as it is now. `before`: save the text as it was before this change, which is how the sentence stood when the writer left it. */
    moment: 'before' | 'after' | null;
    /** Where the sentence being edited starts, to hand back with the next change. */
    sentenceStart: number | null;
}
export declare function autosaveStep(prev: string, next: string, lastSentenceStart: number | null): AutosaveStep;
