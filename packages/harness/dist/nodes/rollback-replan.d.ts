import { StrategyType, StrategyState } from '../state/strategy-state.js';
import { ExperienceStore } from '../state/experience-store.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { TaskGraph, Task } from '../state/task-graph.js';
import { WorldModel } from '../state/world-model.js';
import { CallerState } from '../state/caller-state.js';
import { SupervisorDirective } from '../supervisor.js';
export type ReplanScope = 'LOCAL' | 'GLOBAL';
export interface RollbackReplanResult {
    rolledBack: boolean;
    cannotProgress: boolean;
    newStrategyState: StrategyState;
    newTaskGraph: TaskGraph;
    replanScope: ReplanScope | null;
    /**
     * Set only when failureModeHint (not the supervisor's redirectHint) picked the next strategy —
     * see harness-runtime.ts's onFailureModeSwitch. The bias alone changes bookkeeping only
     * (current_strategy, switch_triggers); nothing in this harness reads a task's chosen strategy
     * during execution, so this is what lets a host surface the classification to the proposer as
     * something to actually act on.
     */
    failureModeSwitch?: {
        failure_class: string;
        strategy: StrategyType;
    };
    /**
     * Set only when the experience-learning feed (HarnessRunOptions.experienceLearning) re-ranked the ladder for this failure
     * class and that ranking picked the next strategy (no supervisor redirect, no failure-mode bias). Like failureModeSwitch it is
     * bookkeeping unless the host surfaces it to the proposer — nothing in this harness reads a task's chosen strategy.
     */
    learnedSwitch?: {
        failure_class: string;
        strategy: StrategyType;
    };
}
export declare const STALL_WINDOW = 5;
export declare const MAX_SWITCHES = 3;
export declare const RECURRENCE_THRESHOLD = 3;
export declare const OSCILLATION_WINDOW = 6;
export declare function cannotMakeProgress(strategyState: StrategyState, failureDiagnostics: FailureDiagnostics): boolean;
export declare function buildStrategyOrdering(failureClass: string, experienceStore: ExperienceStore, _currentStrategy?: StrategyType): StrategyType[];
/**
 * The next strategy from a LEARNED ranking. `getNextStrategy` takes the entry after the current strategy, which is right for the
 * fixed default order but, for a ranking, skips the top choice whenever the current strategy sits above it (current DIRECT_EDIT
 * with [BROADER_SEARCH, TRACE_EXEC, DIRECT_EDIT, …] would land on the fourth entry). Here the nth switch takes the nth-ranked
 * strategy, stepping past the one already in effect, so the learned winner is tried first and later switches walk down the ranking.
 */
export declare function pickLearnedStrategy(ordering: StrategyType[], current: StrategyType, switchCount: number): StrategyType;
/** Flip FAILED leaf tasks (no non-FAILED task depends on them) back to PENDING.
 *  Trajectory Supervisor lever 1 (S8) — twin of replanning.py's requeue_failed_leaves.
 *  A REDIRECT_STRATEGY directive or a completed GATHER_EVIDENCE investigation is a
 *  "retry this task differently" signal, but diagnoseAndReplan (LOCAL) only re-queues
 *  *dependents* of the failed task — on a one-node turn graph nothing lands PENDING and
 *  the redirect / new evidence is never applied. Re-queueing the failed leaf itself
 *  closes that loop. Bounded by the caller (recovery budget, switch_count, cap K).
 *  Returns true iff at least one task was re-queued. */
export declare function requeueFailedLeaves(taskGraph: TaskGraph): boolean;
/** Flip ONE failed task (by id) back to PENDING — even one with dependents (diagnoseAndReplan already reset those to PENDING; they
 *  cannot run until it does). Used for a confident failure-mode match: the classified failure is this task's, so this task gets
 *  the new strategy's attempt. Returns true iff it was FAILED and is now PENDING. */
export declare function requeueFailedTask(taskGraph: TaskGraph, taskId: string): boolean;
/** Flip EVERY FAILED task back to PENDING (retryFailedTask). Unlike requeueFailedLeaves this includes a failed task that has
 *  dependents: those dependents were reset to PENDING by diagnoseAndReplan but cannot run while the task they depend on is still
 *  FAILED, so leaving it failed strands the whole chain. Returns true iff at least one task was re-queued. */
export declare function requeueFailedTasks(taskGraph: TaskGraph): boolean;
export declare function rollbackAndReplan(currentTask: Task, strategyState: StrategyState, failureDiagnostics: FailureDiagnostics, taskGraph: TaskGraph, worldModel: WorldModel, callerState: CallerState, experienceStore: ExperienceStore | null, rollbackFn?: () => void, supervisorDirective?: SupervisorDirective | null, requeueLeafOnLocal?: boolean, learnedLadder?: boolean, retryFailedTask?: boolean): RollbackReplanResult;
