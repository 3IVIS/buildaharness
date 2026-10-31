import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
export interface TaskCompletionResult {
    /** `false` only when the check positively judged the output did not accomplish the task. */
    done: boolean;
    reason?: string;
}
/**
 * `AUDIT_SEMANTIC_TASK_COMPLETION` gate. Default **OFF**: the harness marks a plan task COMPLETE as
 * soon as the reply is produced, exactly as before. A truthy value (`1` / `true` / `on` / `yes` /
 * `enabled`) turns on the per-task check for a durable plan's execution. Unlike the other semantic
 * hooks this one changes plan behaviour (a task judged not done fails instead of completing), so it
 * ships off until a benchmark shows it helps. Read at exactly one site: harness-bridge.ts.
 */
export declare function semanticTaskCompletionEnabled(env?: Record<string, string | undefined>): boolean;
export declare function shortenForCheck(text: string): string;
/**
 * One bounded LLM call: did this output accomplish the task? Fails open — any error, empty output or
 * unparseable response is `done: true`, so a broken check can never strand a plan that would have
 * completed today; only a positive "not done" changes anything.
 */
export declare function checkTaskCompletion(input: {
    taskDescription: string;
    output: unknown;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<TaskCompletionResult>;
