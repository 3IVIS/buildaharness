import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * What a writer's chat message asks for, judged by a model (no word matching): change the text now, propose changes to review, or just
 * talk. The Write page uses it when the chat is in Auto mode, so the writer never has to set a mode before asking for something.
 * A failure or an unclear message is an answer: the cheaper mistake, since the reply offers to apply the change.
 */
export type ChatIntent = 'edit' | 'rewrite' | 'suggest' | 'check' | 'answer';
export type EditScope = 'outline' | 'text' | 'both';
/** What a message asks for, and the web pages it points to as something to follow or draw on (read by the host, which knows whether it can fetch pages). */
export interface WriterIntent {
    intent: ChatIntent;
    links: string[];
    /** For an edit: what it changes. The headings alone (add, rename, move or remove sections), the wording alone, or both (e.g. a new section and what it says). */
    scope: EditScope;
}
export declare function readWriterIntent(input: {
    message: string;
    articleHasText: boolean;
    lastReply?: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void, signal?: AbortSignal): Promise<WriterIntent>;
