import { ArticleMeta } from './article-model.js';
/**
 * Suggested changes (T9). A suggestion never touches the Markdown until the writer accepts it. It stores the exact
 * quoted text it replaces; if that text is no longer where it was (or at all), the suggestion is stale and cannot be
 * accepted as it stands. All functions are pure.
 */
export type SuggestionResult = {
    ok: true;
    meta: ArticleMeta;
    markdown: string;
} | {
    ok: false;
    reason: string;
};
export declare function proposeSuggestion(meta: ArticleMeta, markdown: string, input: {
    quote: string;
    replacement: string;
    reason: string;
    by: 'assistant' | 'writer';
    now: string;
    model?: string;
    ideaIds?: string[];
    commentIds?: string[];
    sectionIds?: string[]; /** Look for the quote from here on, so the first of several equal passages is not always the one meant. */
    from?: number;
}): SuggestionResult;
/** Marks pending suggestions stale when their quoted text no longer exists; refreshes the span of those that moved. */
export declare function refreshSuggestions(meta: ArticleMeta, markdown: string): ArticleMeta;
/** Accepts a pending suggestion, optionally with the writer's own replacement text. Returns the new Markdown. */
export declare function acceptSuggestion(meta: ArticleMeta, markdown: string, id: string, edited?: string): SuggestionResult;
export declare function rejectSuggestion(meta: ArticleMeta, id: string): SuggestionResult & {
    ok: boolean;
};
