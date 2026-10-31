import { ToolExecutorContext } from '@buildaharness/harness';
export interface InjectedFailureOptions {
    /** How many leading harness iterations report a failed execution. */
    failIterations: number;
    /** Recurring same-class `failure_history` records seeded on the first call. */
    seedFailures: number;
    /**
     * How many times the *real* proposer may run after the failure phase (default 2).
     * The first real call is the derailed attempt; a supervisor recovery (a re-queued
     * leaf after GATHER_EVIDENCE / REDIRECT_STRATEGY, S8) gets a second, fresh call so
     * newly gathered evidence in the WorldModel can actually change the answer. Beyond
     * this the last real result is replayed so a thrashing run still converges without
     * unbounded backend cost.
     */
    maxRealCalls?: number;
    /**
     * Called exactly once, the first time the wrapper actually runs (i.e. the failure was really
     * injected into this turn). The benchmark reads it back as `ArmTurnOutput.injectedFailureFired`
     * so `recoveryRate` only counts tasks where the failure genuinely fired for this arm — not
     * every task that merely *declares* an `injectedFailure` (see
     * the internal plan F2).
     */
    onInjected?: () => void;
    /**
     * The failure symptom text (a paraphrase of a known class, a missing resource, a rate limit…).
     * Becomes the seeded records' description, the observation and the failed execution's error, so
     * failure matching sees the task's own wording. Absent = the generic ETIMEDOUT text.
     */
    symptom?: string;
}
type Proposer = (toolCtx: ToolExecutorContext) => unknown | Promise<unknown>;
export declare function wrapProposerWithInjectedFailure(realProposer: Proposer, opts: InjectedFailureOptions): (toolCtx: ToolExecutorContext) => Promise<unknown>;
export {};
