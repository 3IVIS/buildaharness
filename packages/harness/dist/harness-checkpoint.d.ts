import { HarnessRunStateData } from './harness-run-state.js';
import { DepGraphBudgetData } from './state/world-model.js';
import { ReviewerVerdict } from './nodes/reviewer-pass.js';
export interface HarnessRunConfigData {
    objective: string;
    successCriteria: string[];
    maxSteps: number;
    depGraphBudget: DepGraphBudgetData;
    processConceptId: string | null;
}
/**
 * Captures the new propose→gate→execute suspend point (harness-runtime.ts's driveMainLoop):
 * set right after action_gate decides, cleared once execution (or the BLOCK/ESCALATE
 * consequence) has run. A generator's paused stack frame can't survive a real process
 * restart, so this is what makes the pause resumable across one — buildResumedContext
 * reads it back into `ctx.pendingProposal` and driveMainLoop's next iteration re-derives
 * the same task/decision from it instead of re-running select_task/estimate_risk/review
 * (which already ran once, before the pause). `shouldGatherEvidence` is stashed rather
 * than recomputed on resume because estimateVOI can mutate diagnostics.verification_health
 * — recomputing would risk a second, redundant mutation instead of reusing the one that
 * already happened pre-pause. `null` (not just absent) on a checkpoint written after a
 * normal end-of-iteration yield, so a reader can tell "no proposal pending" from "written
 * before this field existed" the same way schemaVersion does.
 *
 * `kind` (Phase D1, schema v2): distinguishes a fresh gate decision ('proposal', the only
 * case that existed before D1) from a still-RUNNING task's toolFn reporting execute.ts's
 * new `status: 'continue'` (`'continuation'`) — the same pendingProposal plumbing resumes
 * either one identically (re-derive the task, skip select_task/estimate_risk/review, run
 * execute() again), so `kind` is informational/audit-trail today, not yet branched on.
 */
export interface PendingProposalData {
    taskId: string;
    gateResult: 'PASS' | 'BLOCK' | 'ESCALATE';
    shouldGatherEvidence: boolean;
    kind: 'proposal' | 'continuation';
}
export interface HarnessRunProgressData {
    stepsUsed: number;
    nodeExecutionOrder: string[];
    finalResult: unknown;
    consecutiveReviewFailures: [string, number][];
    propagationQueue: {
        reopenedTaskIds: string[];
    };
    /** Optional (not just possibly-null) so a pre-Phase-3 checkpoint without this field deserializes as "nothing pending" — same tolerance Phase 0 established for schemaVersion. */
    pendingProposal?: PendingProposalData | null;
    /** Phase I / INV-18. Optional for the same reason as pendingProposal — a pre-Phase-I checkpoint deserializes as "nothing pending". */
    pendingReviewerVerdict?: ReviewerVerdict | null;
    /** Trajectory Supervisor ASK_USER (S3) — per-run count of ASK_USER escalations, so the
     *  per-run cap survives a pause/resume. Optional: a pre-S3 checkpoint deserializes as 0. */
    supervisorAskUserCount?: number;
}
/**
 * Bumped whenever a change to any of the 13 state structures' toJSON()/fromJSON()
 * shapes would make an older checkpoint unreadable. `schemaVersion` is optional on
 * the interface because every checkpoint written before this field existed has none —
 * `CHECKPOINT_MIGRATIONS`/`readCheckpointSchemaVersion` treat that as version 1
 * (the shape that existed before versioning was introduced), not an error.
 *
 * Bumped to 2 in Phase D1: `PendingProposalData.kind` became required (a v1 proposal was
 * always a fresh gate decision — `'continuation'` didn't exist yet), so a v1 checkpoint's
 * `pendingProposal` needs `CHECKPOINT_MIGRATIONS[1]` to stamp `kind: 'proposal'` before it
 * matches the current shape.
 */
export declare const CHECKPOINT_SCHEMA_VERSION = 2;
/**
 * A fully serializable snapshot of an in-progress or completed harness run.
 * Everything needed to reconstruct the 13 state structures and resume the
 * main loop lives here — except experienceStore/updateChannel/toolExecutors,
 * which are live objects the caller must re-supply to resume() (same as the
 * Python state_store: "callers must re-attach a session factory after loading").
 */
export interface HarnessCheckpoint {
    runId: string;
    runState: HarnessRunStateData;
    runConfig: HarnessRunConfigData;
    progress: HarnessRunProgressData;
    schemaVersion?: number;
}
/**
 * Registry of forward migrations, keyed by the version being migrated *from*. First real
 * entry landed in Phase D1 (`[1]`, below) — a future phase that changes a state structure's
 * shape bumps CHECKPOINT_SCHEMA_VERSION and adds
 * `CHECKPOINT_MIGRATIONS[oldVersion] = (raw) => <checkpoint at oldVersion + 1>`
 * here — chained automatically by assertCheckpointSchemaCurrent below.
 */
export declare const CHECKPOINT_MIGRATIONS: Record<number, (raw: HarnessCheckpoint) => HarnessCheckpoint>;
export declare class CheckpointSchemaError extends Error {
    readonly foundVersion: number;
    readonly currentVersion: number;
    constructor(foundVersion: number, currentVersion: number);
}
/**
 * Migrates `checkpoint` forward to CHECKPOINT_SCHEMA_VERSION if a migration path exists,
 * throwing CheckpointSchemaError if it doesn't (including when the checkpoint is from a
 * *newer* schema version than this build knows about). Callers that can tolerate losing
 * a checkpoint (e.g. the storage-layer read below) should catch this and discard it
 * instead of propagating; callers that were explicitly handed a checkpoint to resume
 * (HarnessRuntime.resume()) let it propagate, matching how EscalationHalt is already
 * "rejected rather than swallowed" in this package.
 */
export declare function assertCheckpointSchemaCurrent(checkpoint: HarnessCheckpoint): HarnessCheckpoint;
/**
 * Minimal structural contract for a key-value store that can persist a
 * HarnessCheckpoint. Deliberately duck-typed (not imported) against
 * @buildaharness/runtime's MemoryAdapter so this package keeps zero
 * runtime/browser dependencies — any object with this shape works,
 * including an IndexedDBAdapter or InMemoryAdapter passed in from the caller.
 */
export interface CheckpointStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
}
export declare function saveHarnessCheckpoint(store: CheckpointStore, checkpoint: HarnessCheckpoint): Promise<void>;
/**
 * Reads a checkpoint and migrates it to CHECKPOINT_SCHEMA_VERSION if needed. Unlike
 * HarnessRuntime.resume() (which throws on an unmigratable checkpoint, since a caller
 * explicitly handed it one to resume), this is the "give me whatever's usable or
 * nothing" entry point that the rest of this package already treats `undefined` as
 * meaning — so an unmigratable checkpoint is deleted from the store and this returns
 * `undefined`, the same as if no checkpoint had ever been saved. Callers that already
 * have a discard-and-restart path for a checkpoint that fails to resume (e.g. a
 * RESUME_ATTEMPT_CAP loop) get the same outcome without spending an attempt on a
 * checkpoint that could never have succeeded.
 */
export declare function loadHarnessCheckpoint(store: CheckpointStore, runId: string): Promise<HarnessCheckpoint | undefined>;
export declare function deleteHarnessCheckpoint(store: CheckpointStore, runId: string): Promise<void>;
