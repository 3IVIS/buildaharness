import { AskQuestion, AskResponse } from '@buildaharness/harness';
/**
 * Renders a full AskResponse as one transcript-ready message — shared by
 * AskClarificationService (Q2, resuming a paused harness run) and PlanDraftingService's nested-ask
 * resolution (P8, continuing a plan draft), both of which fold the user's answer into a plain-text
 * follow-up message for their own "next call" rather than duplicating this formatting logic.
 */
/**
 * The user-visible text of a batch of structured questions: each question, then its numbered options. Used for the
 * debug log (a `needs_clarification` turn has `reply: null`, so its log line used to read "(no reply)") and by the
 * eval arm, so the transcript a judge reads carries what the user was actually asked.
 */
export declare function formatAskQuestions(questions: AskQuestion[]): string;
export declare function formatAskResponse(questions: AskQuestion[], response: AskResponse): string;
