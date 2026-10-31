/**
 * What a change did to an article, read from the text before and after: the outline (sections added, removed, renamed, moved) and the
 * sections whose wording changed. A comparison of the two texts, so the chat can say exactly what happened without asking a model.
 */
export interface SectionChange {
    outline: {
        added: string[];
        removed: string[];
        renamed: {
            from: string;
            to: string;
        }[];
        moved: string[];
    };
    /** The added sections that came with text of their own. */
    addedWithText: string[];
    /** Sections that kept their heading and whose text changed. */
    reworded: string[];
    /** What was done to the text of each of those, judged by how much of the old wording is left. */
    how: Record<string, SectionEdit>;
}
export type SectionEdit = 'wrote' | 'cleared' | 'rewrote' | 'added to' | 'shortened' | 'reworded';
export declare function summarizeSectionChange(before: string, after: string): SectionChange;
/** Marks a section name inside chat text, so the chat can show names in a colour instead of between quotation marks. Private-use characters: they never occur in real text. */
export declare const NAME_OPEN = "\uE000";
export declare const NAME_CLOSE = "\uE001";
/** The summary as lines for the chat: one for the outline (when it changed) and one for the wording. Empty when nothing changed. */
export declare function describeSectionChange(c: SectionChange): string;
