import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta } from './article-model.js';
import { ChatTurn } from './writer-chat-history.js';
export type ArticleDraft = {
    status: 'drafted';
    markdown: string;
    name: string;
} | {
    status: 'failed';
    reason: string;
};
/**
 * The text of the string value of `key` in a JSON object that is still being written, as far as it has arrived: escapes are decoded, an escape cut
 * in half at the end is left out, and the value is `undefined` until its opening quote has been written. Used to show a draft as it is typed.
 */
export declare function partialJsonString(json: string, key: string): string | undefined;
/** `onText` is given the article as it has been written so far, while the model is still writing; with it the model's reply is read as it streams. */
export declare function draftArticle(input: {
    meta: ArticleMeta;
    instruction: string;
    current?: string;
    history?: readonly ChatTurn[];
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void, onText?: (markdownSoFar: string) => void): Promise<ArticleDraft>;
