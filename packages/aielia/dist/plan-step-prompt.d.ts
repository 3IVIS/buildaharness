/**
 * `AUDIT_PLAN_STEP_PROMPT` gate. Default **ON**: while an approved plan runs, the model is told which
 * step it is carrying out. A falsy value (`0` / `false` / `off` / `no` / `disabled`) restores the
 * previous behaviour, where every step was run by re-sending the user's message alone. Read at exactly
 * one site: assistant.ts, where the proposer is wired.
 */
export declare function planStepPromptEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * The instruction that makes one step of a plan a distinct piece of work. Without it the harness ran
 * every step through the same proposer with only the user's message ("run the plan"), so each step
 * produced the same answer and none of them did its own step. `description` may already carry the
 * reason a previous attempt was rejected (plan-question.ts's planTasksForRun), which is what lets a
 * retry address it.
 */
export declare function buildStepInstruction(description: string): string;
