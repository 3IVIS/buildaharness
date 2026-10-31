import { WorldModel } from '../state/world-model.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { TaskGraph } from '../state/task-graph.js';
import { Diagnostics } from '../state/diagnostics.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { EvidenceStore } from '../state/evidence-store.js';
import { ControlStateResolverFn } from '../generation-id.js';
import { CallerState } from '../state/caller-state.js';
import { OutputContract } from '../state/output-contract.js';
export declare const RESTART_ITERATION: "RESTART_ITERATION";
export type UpdateCheckResult = typeof RESTART_ITERATION | 'NO_UPDATE';
export interface CallerUpdate {
    pending_update: Record<string, unknown>;
    constraints_changed: boolean;
}
export interface UpdateChannel {
    /**
     * Widened in Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html to allow an async
     * result — the scope×urgency classifier (packages/aielia/src/scope-urgency-classifier.ts) needs
     * a real LLM call to turn a drained steering message into a CallerUpdate, which a synchronous
     * poll() can't do. checkCallerUpdates() below awaits this, so a synchronous implementation
     * (NoOpUpdateChannel, OneShotAnswerChannel) keeps working completely unchanged — `await` on a
     * non-Promise value just resolves it immediately.
     */
    poll(): CallerUpdate | null | Promise<CallerUpdate | null>;
}
export declare class NoOpUpdateChannel implements UpdateChannel {
    poll(): CallerUpdate | null;
}
/**
 * Generic async-producer UpdateChannel — wraps any `() => Promise<CallerUpdate | null>` function.
 * Deliberately free of any goal-graph/steering-specific concept (those live in aielia's
 * goal-graph-reconcile.ts, Phase 4) so this stays a reusable piece of the harness's own public
 * UpdateChannel shape, the same way NoOpUpdateChannel is.
 */
export declare class AsyncFnUpdateChannel implements UpdateChannel {
    private readonly fn;
    constructor(fn: () => Promise<CallerUpdate | null>);
    poll(): Promise<CallerUpdate | null>;
}
export interface ConstraintPropagationContext {
    worldModel: WorldModel;
    hypothesisSet: HypothesisSet;
    taskGraph: TaskGraph;
    diagnostics: Diagnostics;
    failureDiagnostics: FailureDiagnostics;
    evidenceStore?: EvidenceStore;
    outputContract?: OutputContract;
}
/**
 * Matches adapter/harness/constraint_propagation.py's revalidate_task_graph(): blocks
 * non-complete tasks that fall outside the updated success criteria's scope, and adds
 * new PENDING tasks for criteria no active/pending task already covers.
 */
export declare function revalidateTaskGraph(taskGraph: TaskGraph, callerState: CallerState): TaskGraph;
/**
 * Phase 4 (R4's CANCEL_CURRENT branch): blocks every non-terminal task rather than revalidating
 * against success_criteria — a cancellation isn't a scope change to re-derive tasks from, it's an
 * explicit stop. Mirrors revalidateTaskGraph's BLOCKED/block_reason shape (distinct reason string
 * so this is never confused with an ordinary scope_eliminated narrowing) so downstream code that
 * already reads block_reason keeps working unchanged.
 */
export declare function cancelTaskGraph(taskGraph: TaskGraph): void;
/**
 * Matches adapter/harness/constraint_propagation.py's apply_constraint_change_propagation():
 * the single shared entry point for both checkCallerUpdates() and the escalation response
 * handler whenever a caller constraint update arrives. Runs, in order: stale-belief flagging,
 * contradiction re-detection (merged without duplicates), output-contract re-derivation, and
 * task-graph scope revalidation. The caller is responsible for incrementing generation_id and
 * re-resolving control_state after this returns.
 */
export declare function applyConstraintChangePropagation(callerState: CallerState, ctx: ConstraintPropagationContext, _resolverFn?: ControlStateResolverFn): void;
export declare function checkCallerUpdates(callerState: CallerState, updateChannel: UpdateChannel, ctx?: ConstraintPropagationContext, resolverFn?: ControlStateResolverFn): Promise<UpdateCheckResult>;
