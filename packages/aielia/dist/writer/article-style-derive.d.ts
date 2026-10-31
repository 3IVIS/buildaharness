import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta } from './article-model.js';
/**
 * A first style sheet drawn from the text of an article that was just loaded: who it seems written for, what it does, how it sounds, how long
 * it is, how the author writes, and the terms it uses consistently. One model call describes what the text shows. The result only fills what the
 * writer has not set: a brief field that already has text is kept, and a writing profile already on the article is kept. Everything it writes is
 * the writer's to edit, and it is never given back to the model as if the writer had said it.
 */
/** The most of the article sent, in characters. */
export declare const STYLE_DERIVE_MAX_CHARS = 12000;
export interface DerivedStyle {
    status: 'derived' | 'not_derived';
    meta: ArticleMeta;
    /** What was filled in, for a plain sentence to the writer: brief field names, and "writing profile". */
    filled: string[];
    /** Why nothing was derived, when the model call failed or its answer could not be read. */
    reason?: string;
}
export declare function deriveStyle(input: {
    meta: ArticleMeta;
    markdown: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<DerivedStyle>;
/** About one page of text. */
export declare const STYLE_DERIVE_MIN_WORDS = 300;
/** Whether the style sheet should be drawn from the text now: there is a page of text and the writer has set nothing yet. */
export declare function shouldDeriveStyle(meta: Pick<ArticleMeta, 'brief' | 'style'>, markdown: string): boolean;
