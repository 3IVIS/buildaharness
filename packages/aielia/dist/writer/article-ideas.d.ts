import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta, Idea } from './article-model.js';
export type IdeaResult = {
    ok: true;
    meta: ArticleMeta;
    idea: Idea;
} | {
    ok: false;
    reason: string;
};
export declare function addIdea(meta: ArticleMeta, input: {
    text: string;
    origin: Idea['origin'];
    model?: string;
    sectionId?: string;
}, now: string): IdeaResult;
export declare function setIdeaState(meta: ArticleMeta, id: string, state: Idea['state']): IdeaResult;
export declare function editIdea(meta: ArticleMeta, id: string, patch: {
    text?: string;
    sectionId?: string | null;
}): IdeaResult;
export declare function removeIdea(meta: ArticleMeta, id: string): ArticleMeta;
export interface IdeaSuggestion {
    status: 'suggested' | 'failed';
    meta: ArticleMeta;
    added: Idea[];
}
export declare function suggestIdeas(input: {
    meta: ArticleMeta;
    markdown: string;
    request?: string;
    now: string;
    modelName?: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<IdeaSuggestion>;
