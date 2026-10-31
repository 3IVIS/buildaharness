import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleRef, CaptureOp, WriterChatState } from './writer-chat-state.js';
/**
 * Reads one message from the writer and proposes changes to the article's chat-held state. The meaning is judged by a
 * model; this module only stores the result (no word matching). Only the writer's own message is read, never the
 * assistant's replies. One bounded call; any failure leaves the state unchanged and says so.
 */
export type CaptureStatus = 'captured' | 'needs_article' | 'not_captured';
export interface CaptureResult {
    status: CaptureStatus;
    state: WriterChatState;
    /** The article the message concerns, when it could be told. The caller keeps it as the active article. */
    articleId?: string;
    applied: string[];
    skipped: string[];
    /** Set with `needs_article`: apply these with `applyCaptureOps` once the writer names the article. */
    pendingOps?: CaptureOp[];
    question?: string;
}
export declare function captureChatState(input: {
    message: string;
    state: WriterChatState;
    articles: readonly ArticleRef[];
    now?: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<CaptureResult>;
