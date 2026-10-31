import { ChatMessage } from '@buildaharness/runtime';
/**
 * The conversation so far, as the earlier messages of a model call that changes the article. A change is asked for in the middle of a talk
 * ("add the rest of those to the problem section"), so the call must see the talk; it goes before the article and the instruction, so that
 * what is the same from one request to the next stays at the start, where a provider can reuse it.
 */
export interface ChatTurn {
    from: 'you' | 'aielia';
    text: string;
}
/**
 * Alternating user and assistant messages from the newest turns: each clipped, runs by the same side joined, the oldest dropped to fit,
 * starting with the writer and ending with the assistant (the writer's newest message is the instruction, which the caller adds).
 */
export declare function chatHistoryMessages(turns: readonly ChatTurn[] | undefined): ChatMessage[];
/** Added to the instructions of a call that is given the conversation. */
export declare const CHAT_HISTORY_NOTE = " The messages before the last are the conversation so far between the writer and the assistant: the instruction may refer to them (\"those\", \"the rest\", \"what you listed\"); follow the instruction, and take from the conversation only what it points to.";
