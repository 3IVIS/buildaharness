import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta } from './article-model.js';
import { ChatTurn } from './writer-chat-history.js';
/**
 * Turns the writer's instruction ("fix the figure as C1 asks", "tighten the intro") into suggested changes: exact quoted
 * text plus a replacement and a reason (T9). Nothing is applied here; every suggestion waits for the writer. Quotes that
 * are not in the text are dropped and reported, so a suggestion can always be found again.
 */
export interface EditSuggestResult {
    status: 'suggested' | 'failed';
    meta: ArticleMeta;
    added: string[];
    /** Model proposals that could not be anchored in the text. */
    dropped: string[];
}
export declare function suggestEdits(input: {
    meta: ArticleMeta;
    markdown: string;
    instruction: string;
    now: string;
    modelName?: string; /** Revise only the text in this range: the model is shown it, and a change outside it is dropped. */
    focus?: {
        start: number;
        end: number;
    };
    ideaIds?: string[];
    commentIds?: string[];
    sectionIds?: string[]; /** The talk so far, so the instruction can refer to it. */
    history?: readonly ChatTurn[];
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<EditSuggestResult>;
