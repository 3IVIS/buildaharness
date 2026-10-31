import { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime';
import { CaptureStatus } from './writer-chat-capture.js';
import { ArticleRef, CaptureOp, WriterChatState } from './writer-chat-state.js';
/**
 * One turn of the chat-held state (T13): capture what the writer's message adds, store it per article (not per
 * session), and return the block the assistant's system prompt gets. The host supplies a port for storage and for the
 * list of articles; with no port the assistant does none of this.
 */
export interface WriterChatPort {
    articles(): Promise<ArticleRef[]> | ArticleRef[];
    load(): Promise<WriterChatState>;
    save(state: WriterChatState): Promise<void>;
    getActive(): Promise<string | undefined>;
    setActive(articleId: string | undefined): Promise<void>;
    getPending(): Promise<CaptureOp[] | undefined>;
    setPending(ops: CaptureOp[] | undefined): Promise<void>;
    /** The current text of an article, when the host can give it. Shown to the answering model so it can talk about what is on the page (clipped). */
    articleText?(articleId: string): Promise<string | undefined>;
    /** False when the writer has turned chat capture off: the message is not read, but what is already recorded is still shown. */
    captureEnabled?(): Promise<boolean>;
    /** The ideas on the article's list that are not in the text yet, as plain lines. Shown to the answering model so the writer can talk about them. */
    ideasText?(articleId: string): Promise<string[]>;
    /** The writer's brief and writing profile for the article as plain text, or '' when there is none. */
    styleText?(articleId: string): Promise<string>;
    /** What is still open before the article is ready, as plain lines, or '' when nothing is. */
    openItemsText?(articleId: string): Promise<string>;
    /** The article's stored sources as text (address and passage), or '' when there are none. Shown to the answering model so it can use them. */
    sourcesText?(articleId: string): Promise<string>;
}
/** A port backed by the assistant's own memory adapter. The articles list comes from the host (the page that owns the articles). */
export declare function createMemoryWriterChatPort(memory: MemoryAdapter, articles: () => Promise<ArticleRef[]> | ArticleRef[]): WriterChatPort;
/**
 * Only the recording half of a turn, for a message that asks for an edit, a draft or suggestions: what the writer says is read and kept in the
 * article's record exactly as in a full turn (the edit reads that record), but no reply is written, so it is one model call instead of the
 * whole turn. Never throws: a failure is reported as `not_captured`.
 */
export declare function recordWriterMessage(input: {
    message: string;
    port: WriterChatPort;
    now?: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<{
    status: CaptureStatus | 'off';
}>;
/**
 * Returns the text to append to the system prompt for this turn (empty when there is nothing to say). Never throws:
 * a failure of any kind returns the not-captured note, so the assistant cannot claim something was saved that was not.
 */
export declare function processWriterMessage(input: {
    message: string;
    port: WriterChatPort;
    now?: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<string>;
