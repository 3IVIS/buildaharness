import { ChatMessage } from '@buildaharness/runtime';
/**
 * What a model call was for, so the page can show where the writer's money went. The call type is read from the opening words of the
 * call's system prompt (each step of the article service has its own); a call with none of these is the chat answering the writer.
 * A test runs every step and fails if one is not recognised here, so a reworded prompt cannot silently move its cost to "chat".
 */
export interface CallType {
    id: string;
    label: string;
    /** The start of the step's system prompt. */
    marker: string;
}
export declare const CALL_TYPES: readonly CallType[];
export declare const CHAT_CALL: CallType;
export declare function classifyCall(messages: readonly ChatMessage[]): CallType;
export declare function callTypeLabel(id: string): string;
