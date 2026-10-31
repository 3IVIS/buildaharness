import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta } from './article-model.js';
/**
 * The consistency pass (E10, E11): one model call over the whole article and the text of its sources. It looks for what a check of single claims
 * against their sources cannot see: two statements of the article that cannot both be true (or a conclusion that does not follow from the article's
 * own figures), and advice or a general statement that goes further than the sources say they cover. Every judgement is the model's. This module
 * only keeps findings whose quote is really in the text, marks the section they are in as needing review with the reason (the same mark the resolver
 * uses; only the writer clears it) and reports what it did. A failure, or an article too long to send whole, leaves the article as it was.
 */
export interface ConsistencyFinding {
    sectionId: string;
    kind: 'conflict' | 'overreach';
    quote: string;
    reason: string;
}
export interface ConsistencyResult {
    status: 'checked' | 'not_checked' | 'too_long';
    meta: ArticleMeta;
    findings: ConsistencyFinding[];
}
/** The longest article sent whole, in characters. */
export declare const CONSISTENCY_MAX_ARTICLE_CHARS = 24000;
export declare function checkConsistency(input: {
    meta: ArticleMeta;
    markdown: string;
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<ConsistencyResult>;
