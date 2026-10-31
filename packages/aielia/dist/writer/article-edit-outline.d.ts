import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta } from './article-model.js';
import { ChatTurn } from './writer-chat-history.js';
export type OutlineEdit = {
    status: 'edited';
    outline: string;
} | {
    status: 'failed';
    reason: string;
};
export declare function editOutline(input: {
    meta: ArticleMeta;
    outline: string;
    instruction: string;
    history?: readonly ChatTurn[];
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<OutlineEdit>;
