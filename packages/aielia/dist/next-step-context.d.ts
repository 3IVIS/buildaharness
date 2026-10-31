import { ChatMessage } from '@buildaharness/runtime';
import { GoalGraphRecord } from './goal-graph-store.js';
import { AssistantSource } from './assistant-source.js';
export interface NextStepConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}
export interface NextStepGoalOverview {
    goal: string;
    status: string;
    /** True for the thread the suggestion is about (the finished thread, or the active one at turn end). */
    focus: boolean;
    tasks: {
        description: string;
        status: string;
    }[];
    /**
     * Next steps already proposed for this goal when it finished (the high/medium-confidence ones the
     * thread persisted), for goals other than the focus one. They are how an open item of an earlier
     * goal survives after that goal has left the conversation window. Absent when there are none.
     */
    openSuggestions?: string[];
}
export interface NextStepContext {
    /** Earlier user/assistant messages, oldest first, excluding the exchange the suggestion is about. */
    conversation?: NextStepConversationTurn[];
    /** Every goal thread the session tracks, unfinished ones first. */
    goals?: NextStepGoalOverview[];
    /** Files read / searches made while producing this turn's reply. */
    stepsThisTurn?: string[];
}
/**
 * The last few user/assistant messages, oldest first. `currentExchange`, when given, drops the
 * trailing user+assistant pair that is the exchange being suggested for (the proposer already gets
 * it in full), so it is not sent twice. Tool messages and empty messages are skipped.
 */
export declare function summarizeConversation(transcript: ChatMessage[], currentExchange?: {
    userMessage: string;
}): NextStepConversationTurn[];
/** Every goal thread with its tasks, the focus thread and unfinished threads first. Abandoned threads are left out. */
export declare function summarizeGoalGraph(record: GoalGraphRecord | undefined, focusThreadId?: string): NextStepGoalOverview[];
export declare function summarizeSteps(sources: AssistantSource[] | undefined): string[];
export declare function buildNextStepContext(parts: {
    transcript?: ChatMessage[];
    currentExchange?: {
        userMessage: string;
    };
    goalGraph?: GoalGraphRecord;
    focusThreadId?: string;
    sources?: AssistantSource[];
}): NextStepContext;
