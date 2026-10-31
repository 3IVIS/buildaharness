import { PlanRecord, PlanTaskRecord } from './plan-store.js';
/**
 * How a message that only asks about the active plan (the classifier's `isPlanQuestion`) is handled:
 * - `stuck` (default): answered from the plan's recorded state ONLY while the plan is stuck on a failed
 *   task — exactly where re-driving the plan is known to go wrong. A healthy plan behaves as it always
 *   has, so this default changes nothing for it.
 * - `always`: any plan question is answered from the recorded state, healthy plan or not.
 * - `off`: an active plan drives every non-trivial turn (the pre-routing behaviour).
 * `AUDIT_PLAN_QUESTION_ROUTING`: `always`/`on`/`1`/`true` → always; `0`/`false`/`off`/`no`/`disabled` → off;
 * empty or `stuck` → stuck. Read at exactly one site: assistant.ts, where the turn is routed.
 */
export type PlanQuestionRouting = 'off' | 'stuck' | 'always';
export declare function planQuestionRoutingMode(env?: Record<string, string | undefined>): PlanQuestionRouting;
/** A plan is stuck when a step failed and was not skipped: the harness cannot advance past it on its own. */
export declare function isPlanStuck(plan: PlanRecord): boolean;
export declare function shouldRoutePlanQuestion(input: {
    mode: PlanQuestionRouting;
    plan: PlanRecord | null;
    isPlanQuestion: boolean | undefined;
}): boolean;
/**
 * `AUDIT_STUCK_PLAN_RESUME` (default ON): a plan stuck on a failed step is resumed only by a message that says to carry it
 * on (the classifier's `continuesPlan`). Any other message is answered on its own terms — the plan is not handed to the
 * harness, so the failed step is not silently retried — and the reply ends by asking whether to retry it. `0`/`false`/
 * `off`/`no`/`disabled` restores the old behaviour (any non-trivial message on a stuck plan retries the step).
 */
export declare function stuckPlanResumeEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * True when the turn should set the stuck plan aside: the plan is stuck, the message is not a question about it (that is
 * routed separately) and the classifier said explicitly that it does not continue it. A missing `continuesPlan` is not
 * "no" — it keeps today's behaviour.
 */
export declare function shouldSetAsideStuckPlan(input: {
    enabled: boolean;
    plan: PlanRecord | null;
    isPlanQuestion: boolean | undefined;
    continuesPlan: boolean | undefined;
}): boolean;
/** Prompt addendum for a turn that set a stuck plan aside: answer the message, then ask about the failed step. */
export declare function renderStuckPlanNudge(plan: PlanRecord): string;
/**
 * The plan's tasks as the harness should see them for a turn that moves the plan forward. A step that
 * failed is put back to pending so it gets another attempt (left as FAILED it would strand the run on
 * every later turn), and its description carries why the last attempt was rejected so the retry can
 * address that instead of repeating it. Only the harness's copy changes: the stored plan keeps its
 * original description, and its status is rewritten from the run's outcome afterwards.
 */
export declare function planTasksForRun(tasks: PlanTaskRecord[]): PlanTaskRecord[];
/**
 * What to add to the reply of a turn that ran an approved plan and stopped because a step was not
 * accepted as done. Without it the reply is just the last step that DID complete, and the user only finds
 * out the plan stalled by asking. Empty when nothing was rejected this turn.
 */
export declare function renderPlanStopNote(plan: PlanRecord, taskNotes: Record<string, string> | undefined): string;
/**
 * The plan's real state, rendered for the prompt of a turn that only asks about it. Grounds the answer
 * in what the task graph actually recorded (a task is "done" only if it completed; a failed one carries
 * the reason it was not accepted) so the reply can't drift into describing the plan as it was drafted.
 */
export declare function renderPlanStateBlock(plan: PlanRecord): string;
