import { WorldModel, BeliefDepGraph } from '../state/world-model.js';
import { EvidenceStore } from '../state/evidence-store.js';
import { TaskGraph, Task } from '../state/task-graph.js';
import { MemoryState } from '../state/memory-state.js';
import { Diagnostics } from '../state/diagnostics.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { ControlState } from '../state/control-state.js';
export type ReversibilityStrategy = 'snapshot' | 'git-revert' | 'patch-rollback' | 'ephemeral';
/**
 * Phase D1: what a toolFn's return means for the task's lifecycle. 'complete' is what every
 * toolFn produced before this phase (a plain, non-throwing return) and stays the default for
 * one — driveMainLoop marks the task COMPLETE exactly as it always has. 'continue' is new: the
 * task stays RUNNING and the harness re-executes it on the next main-loop iteration (via the
 * same pendingProposal suspend point Phase 3 built, so a real process restart between two
 * 'continue' steps resumes correctly — see PendingProposalData.kind). 'failed' from a
 * non-throwing return gets the identical SYSTEM_ERROR evidence + task-FAILED treatment a thrown
 * error already gets — a toolFn that already distinguishes its own failure modes doesn't need to
 * throw just to get that.
 */
export type ExecutionStatus = 'continue' | 'complete' | 'failed';
export interface ExecutionResult {
    success: boolean;
    output: unknown;
    error: string | null;
    strategy: ReversibilityStrategy;
    rollback_ref: string | null;
    status: ExecutionStatus;
    /**
     * Why a failed execution failed. `system_error`: the executor threw, or reported a failure without saying why (the tool or
     * model call itself broke). `exhausted`: the executor ran out of its own iteration budget — retrying the same task under
     * a new strategy is the runaway loop all over again. Absent when the execution did not fail.
     */
    failure_kind?: ExecutionFailureKind;
}
export type ExecutionFailureKind = 'system_error' | 'exhausted';
/**
 * Opt-in structured return for a toolFn that needs to signal 'continue' or a non-throwing
 * 'failed' — a toolFn that just returns a plain value (every toolFn written before Phase D1)
 * is unaffected and always resolves to status 'complete', exactly as before.
 */
export interface ContinuableExecutionOutcome {
    __harnessExecutionStatus: ExecutionStatus;
    output?: unknown;
    error?: string;
    /** Only read for a `failed` status; absent means `system_error`. */
    __harnessFailureKind?: ExecutionFailureKind;
}
/**
 * Phase D2: a marker a toolFn's thrown error can carry to mean "this isn't a real execution
 * failure" — e.g. a harness-driven proposer throwing this to signal a turn needs a human
 * approval (write_file/run_shell_command/send_email) or has hit its own escalation, neither of
 * which is "the tool broke." execute() rethrows it unexamined below instead of recording
 * SYSTEM_ERROR evidence + a task-FAILED transition, the same way EscalationHalt already
 * propagates untouched out of the main loop rather than being treated as a tool error.
 */
export interface HarnessPauseSignal {
    __harnessPause: true;
}
export declare function isHarnessPauseSignal(value: unknown): value is HarnessPauseSignal;
export interface ProposedExecutionChange {
    description?: string;
    change_type?: 'read-only' | 'schema' | 'infra' | 'file_mutation';
    required_resources?: string[];
    required_state_structures?: string[];
}
export interface ExecutionContext {
    worldModel: WorldModel;
    evidenceStore: EvidenceStore;
    taskGraph: TaskGraph;
    currentTask: Task;
    memoryState: MemoryState;
    beliefDepGraph?: BeliefDepGraph;
    planToolWorkflow?: () => void;
    /**
     * R2 of the D2 one-loop-rewire follow-up plan (the internal plan):
     * this main-loop iteration's already-resolved ControlState (see driveMainLoop's actionGate
     * block, which runs before execute() is ever called) — optional so every pre-existing test
     * that builds an ExecutionContext by hand without one keeps compiling unchanged. Threaded
     * through to toolFn as ToolExecutorContext below so a harness-driven proposer can fold its own
     * tool-call bookkeeping into the harness's own live state instead of maintaining a second,
     * parallel ControlState (see personal-assistant's tool-control-plane.ts, which this was written
     * to let go of duplicating).
     */
    controlState?: ControlState;
    diagnostics?: Diagnostics;
    failureDiagnostics?: FailureDiagnostics;
}
/**
 * R2 of the D2 one-loop-rewire follow-up plan: what a toolFn actually receives when
 * driveMainLoop calls it. A toolFn written before this phase ignores its argument entirely
 * (JS/TS both allow calling a function with more arguments than it declares) and is completely
 * unaffected. A harness-driven proposer (personal-assistant's one-loop-proposer machinery) reads
 * `controlState` to gate its own tool calls (tool-policy.ts's evaluateToolPolicy) against the
 * exact same ControlState driveMainLoop's own actionGate will re-resolve on the next iteration —
 * and, when it records a tool outcome, mutates `worldModel`/`evidenceStore`/`diagnostics`/
 * `failureDiagnostics` directly (the harness's own live state for this run), so that bookkeeping
 * feeds the *same* resolveControlState() call the harness's main loop already makes each
 * iteration instead of a second, disconnected structure.
 */
export interface ToolExecutorContext {
    worldModel: WorldModel;
    evidenceStore: EvidenceStore;
    controlState?: ControlState;
    diagnostics?: Diagnostics;
    failureDiagnostics?: FailureDiagnostics;
    /**
     * P10 of the internal plan: the id of the task `toolFn` is being
     * invoked for (mirrors `ExecutionContext.currentTask.id`, the one value `execute()` already
     * had in scope but never threaded through before this phase) — lets a harness-driven proposer
     * (personal-assistant's `OneLoopPause`) tag a pending write/shell/email approval with which
     * plan task, if any, was RUNNING when it was proposed, for the "trust this approved plan" INV-36
     * check. No twin: this is a TS-only field on a TS-only interface, not part of any
     * Python/TS conformance surface. Optional (unlike the other fields `execute()` always
     * populates) only so every existing hand-built `ToolExecutorContext` test fixture that predates
     * this field keeps compiling unchanged — `execute()` itself always sets it.
     */
    currentTaskId?: string;
}
export declare function execute(proposedChange: ProposedExecutionChange, toolFn: ((toolCtx: ToolExecutorContext) => unknown | Promise<unknown>), ctx: ExecutionContext): Promise<ExecutionResult>;
