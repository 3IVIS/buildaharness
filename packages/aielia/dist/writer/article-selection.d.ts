/**
 * Growing a selection by units of writing: a sentence, then the paragraph, then the section (a heading and everything under it, down to the next
 * heading of the same or a higher level), then the whole article. Each step is the next unit that strictly contains the current selection, so a
 * word, a sentence and several sentences all grow sensibly. Pure; the page keeps the earlier selections to shrink back. Units are found in the text
 * as it is now (not from saved sections), so they are right while the writer is typing.
 */
export type SelectionUnit = 'sentence' | 'paragraph' | 'section' | 'article';
export interface SelectionRange {
    start: number;
    end: number;
}
/**
 * The next larger unit around the selection, or undefined when the whole article is already selected. With `wholeArticle: false` the whole article
 * is never offered (nor a section that is all of it), so the largest selection is the one just below it: the writer then starts over from the sentence.
 */
export declare function expandSelection(text: string, range: SelectionRange, options?: {
    wholeArticle?: boolean;
}): {
    range: SelectionRange;
    unit: SelectionUnit;
} | undefined;
/** The unit the selection is: a selection that is exactly a sentence, paragraph or section is that unit; a cursor or a phrase is the sentence around it; anything longer, the smallest unit that holds it. */
export declare function unitOfSelection(text: string, range: SelectionRange): {
    range: SelectionRange;
    unit: SelectionUnit;
} | undefined;
