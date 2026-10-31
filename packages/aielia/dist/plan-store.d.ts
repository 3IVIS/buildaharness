import { FsBackend, MemoryAdapter } from '@buildaharness/runtime';
import { TaskStatus } from '@buildaharness/harness';
import { Plan } from './plan-builder.js';
export interface PlanTaskRecord {
    id: string;
    description: string;
    depends_on: string[];
    status: TaskStatus;
    /**
     * Per-task risk, attached at plan-creation time (see plan-builder.ts's buildPlanFromTemplate)
     * instead of re-derived from the description text on every resume. Optional only for backward
     * compatibility with a plan persisted before this field existed — assistant.ts's
     * toHarnessTasks falls back to the lexical planTaskRiskLevel/classifyRisk for those.
     */
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    /**
     * True once the user explicitly cancelled this specific task (see matchTaskCancelAttempt/
     * cancelPlanTask) — distinct from `status`, which gets set to 'COMPLETE' alongside this so the
     * harness's task-graph selection and dependent-unblocking treat it as resolved the same way a
     * genuinely finished task would be (TaskStatus, from @buildaharness/harness, has no CANCELLED
     * value of its own — extending that union is a cross-package change out of scope here).
     * formatPlanProgress/planCompletionPct read this flag to show/count it accurately instead of
     * claiming the user's own work actually got done.
     */
    cancelled?: boolean;
    /**
     * Why the last attempt at this task did not count as done — set when the semantic task-completion
     * check judged its output did not do the task (task-completion-check.ts), so a later turn can say
     * why the plan is stuck. Cleared once the task completes. Absent otherwise.
     */
    statusNote?: string;
}
/**
 * Superset of the old 3-value `status`: 'drafting' and 'awaiting_approval' are new (plan mode's
 * P1/P2 — not wired to any producer yet, this phase is schema-only), 'active'/'done'/'abandoned'
 * are the pre-existing values, unchanged in meaning.
 */
export type PlanMode = 'drafting' | 'awaiting_approval' | 'active' | 'done' | 'abandoned';
export interface PlanRecord {
    /** null for a fully custom-drafted plan (P3) that isn't seeded from one of the named templates. */
    templateName: string | null;
    successCriteria: string;
    /** Why this approach, not just the success criteria — see Plan.rationale. */
    rationale: string;
    tasks: PlanTaskRecord[];
    mode: PlanMode;
    /** Populated by plan mode's P6 self-verification pass. */
    reviewNotes?: string[];
    verifiedAt?: string;
    /** Whether the harness should auto-advance through this plan's tasks without a per-step pacing pause (plan mode's P4). */
    executingOnPlan: boolean;
    /**
     * Plan mode's P10 "trust this approved plan" opt-in — absent/false (the default, "absent when
     * unused" per this codebase's convention for additive fields) means every write/shell/email
     * action this plan's execution proposes stays individually gated exactly as before this phase.
     * `true` only once the user chose `'approve_trusted'` at the P2 approval screen (never the
     * default choice there — see PlanApprovalService) — while true, an action proposed during
     * execution of whichever task is this plan's currently RUNNING one is auto-applied instead of
     * staged (INV-36; see assistant.ts's buildToolLoopPauseResult). Per-plan, not global or
     * per-session: a fresh plan, or this same plan reloaded after `abandonPlan`, starts back at
     * false.
     */
    trustApprovedSteps?: boolean;
    /**
     * Set only while `mode === 'awaiting_approval'` (plan mode's P2) — correlates a
     * `turn(message, { planApprovalId, planDecision })` resolution to exactly this staged snapshot,
     * same "resolved by ID, never re-derived" discipline pendingActionId/pendingClarificationId
     * already follow. Cleared (undefined) once the plan is activated or the draft is abandoned.
     */
    planApprovalId?: string;
    createdAt: string;
    updatedAt: string;
}
/** Pre-P0 persisted shape: `status` instead of `mode`, no `rationale`/`executingOnPlan`. */
interface LegacyPlanRecordShape {
    templateName: string;
    successCriteria: string;
    tasks: PlanTaskRecord[];
    status: 'active' | 'done' | 'abandoned';
    createdAt: string;
    updatedAt: string;
}
/**
 * Maps a persisted record — old 3-value `status` shape or the current 5-value `mode` shape — to
 * the current PlanRecord shape, same "default pre-existing records without demoting a real value"
 * convention fact-extraction.ts's migrateFact already uses elsewhere in this package. A migrated
 * `active` plan gets `executingOnPlan: true` so an in-flight plan from before this change keeps
 * progressing rather than silently stalling.
 */
export declare function migratePlanRecord(record: PlanRecord | LegacyPlanRecordShape): PlanRecord;
/**
 * Plan mode's P5 file-backed persistence: when a real filesystem is available (CLI/desktop —
 * the same `{backend, workspaceRoot}` pair AssistantSession.undoWorkspace() already resolves for
 * write_file/run_shell_command), every plan write is mirrored to
 * `<workspaceRoot>/.buildaharness/plans/<sessionId>.plan.json` (plus a generated `.plan.md`
 * view), and every load prefers that file over the Dexie/IndexedDB State-tier record so a
 * hand-edit to the JSON between turns is picked up. On a surface with no filesystem (a browser
 * tab), this is `undefined` throughout and Dexie alone remains the source of truth, unchanged
 * from before P5.
 */
export interface PlanFsPersistence {
    backend: FsBackend;
    workspaceRoot: string;
}
/**
 * Removes the session's mirrored plan files. `loadPlanRecord` prefers the file over the memory record,
 * so deleting only the memory record (`/new`) let the old plan come straight back. Never throws.
 */
export declare function deletePlanFiles(fsPersistence: PlanFsPersistence, sessionId: string): Promise<void>;
/**
 * Reads `sessionId`'s stored plan record regardless of `mode` — unlike `loadActivePlan`, which
 * filters to `mode === 'active'` only. Plan mode's P1 drafting path needs to resume a
 * `mode: 'drafting'` record across turns (and P2 needs `awaiting_approval` the same way), neither
 * of which `loadActivePlan` would ever return.
 *
 * When `fsPersistence` is configured and its plan JSON file exists, that file wins over the
 * Dexie/State-tier record (P5 — the file is the editable-and-reloadable artifact, so a hand-edit
 * between turns takes effect on the very next load) and is written back into `memory` to
 * reconcile the two (INV-33: after any interrupted dual write, the next load's result is
 * self-consistent and Dexie catches back up to it, rather than the two staying silently split).
 */
export declare function loadPlanRecord(memory: MemoryAdapter, sessionId: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord | null>;
/** Returns null when no plan exists for this session, or the stored plan is already done/abandoned — a finished plan never auto-resumes. */
export declare function loadActivePlan(memory: MemoryAdapter, sessionId: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord | null>;
/**
 * Builds an immediately-`active` PlanRecord with no drafting/approval step at all. Before P3 of
 * the internal plan, TurnInterpreter.resolveTasks called this the instant
 * classifyTurnIntent matched a template; P3 retired that call site — a template match (or the
 * newer general needsMultiStepPlan judgment) now always routes through plan mode's exclusive
 * drafting+approval loop instead (see assistant.ts's auto-trigger and
 * PlanDraftingService.draftTurn's template-seeding). This function itself is unchanged and still
 * used directly by tests/callers that want to seed an already-active plan without going through
 * drafting. The ONLY other place `mode: 'active'` is ever set is `activatePlanRecord` below,
 * reached solely via a drafted plan's explicit approve/approve-with-edits (INV-31) — this function
 * remains the one intentional exception to "exactly one place", now purely a low-level primitive
 * rather than something classification wires up automatically.
 */
export declare function createPlanRecord(plan: Plan): PlanRecord;
/**
 * The funnel every plan mutation in this module writes through. When `fsPersistence` is
 * configured, the fs file is written first and Dexie second (P5, INV-33): if the process dies
 * between the two, the fs file — which `loadPlanRecord` always prefers when present — already
 * reflects either the old state (rename never happened) or the new one (rename completed),
 * never a half-written file, so the next load resolves to one consistent version of both instead
 * of a silently split pair.
 */
export declare function savePlan(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<void>;
/**
 * A fresh, empty `mode: 'drafting'` record — the seed for plan mode's P1 drafting loop, started
 * either from nothing (a from-scratch draft, P3) or already carrying a `templateName` seed.
 * Unlike `createPlanRecord`, `executingOnPlan` starts false (P4's auto-advance only ever applies
 * once P2 approval flips the record to `active`) and `mode` starts `'drafting'`, not `'active'`.
 */
export declare function createDraftPlanRecord(templateName: string | null): PlanRecord;
export declare function abandonPlan(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<void>;
/**
 * Stages a drafted plan for plan mode's P2 mandatory whole-plan approval gate: `mode` moves to
 * `'awaiting_approval'` and a fresh `planApprovalId` is minted so the eventual
 * `turn(message, { planApprovalId, planDecision })` resolves exactly this snapshot, never a
 * second, re-derived one (see PlanRecord.planApprovalId's doc comment).
 */
export declare function stagePlanForApproval(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<PlanRecord>;
/**
 * The sole place a *drafted* plan reaches `mode: 'active'` (INV-31) — called only from
 * PlanApprovalService's approve/approve-with-edits branch, once any edits have already landed on
 * `plan`. `createPlanRecord` above sets `mode: 'active'` too, but that's the pre-existing,
 * unrelated template-instant-match path — not a second way for a *drafted* plan to skip approval.
 * `planApprovalId` is cleared since the staged snapshot it correlated to no longer exists once
 * activated.
 */
export declare function activatePlanRecord(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, fsPersistence?: PlanFsPersistence): Promise<PlanRecord>;
export interface TaskCancelMatch {
    taskId: string;
    taskDescription: string;
}
/**
 * Detects a request to cancel/skip ONE task within an active plan — distinct from
 * classifyTurnIntent's isAbandonRequest judgment, which is about ending the WHOLE plan (see
 * conv59/conv70's h9 finding: "cancel the daily-budget task" isn't asking to abandon a trip-planning
 * plan entirely, just to drop one of its steps, and there was no feature to route that to at
 * all). Matches a cancel-shaped verb (cancel/skip/drop/remove), an explicit reference to the plan
 * or one of its tasks/steps (TASK_REFERENCE_MARKER), together with a distinctive word (4+ letters,
 * not a common stopword) shared with one of the plan's own not-yet-complete task
 * descriptions/ids — deliberately conservative: a bare "cancel" with no recognizable task
 * reference (e.g. "cancel my gym membership", unrelated to anything in this plan, or "cancel my
 * travel insurance policy with my current provider", a genuine external request that merely
 * happens to share a word with a task description) returns null and falls through to the ordinary
 * message-level risk gate, same as today. Returns the first matching task in plan order, or null.
 */
export declare function matchTaskCancelAttempt(message: string, plan: PlanRecord): TaskCancelMatch | null;
/**
 * Cancels one task within an active plan — internal bookkeeping only (see PlanTaskRecord.cancelled
 * for why status becomes 'COMPLETE' alongside the cancelled flag). Unlike abandonPlan, the plan
 * itself stays 'active' so the remaining tasks continue normally.
 */
export declare function cancelPlanTask(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, taskId: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord>;
/**
 * Changes one task's description without marking it complete — a lighter sibling of
 * cancelPlanTask, for plan mode's P2 approve-with-edits path (a user can want a task reworded
 * without dropping it entirely, which cancelPlanTask's "mark COMPLETE + cancelled" would do).
 */
export declare function editPlanTask(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, taskId: string, newDescription: string, fsPersistence?: PlanFsPersistence): Promise<PlanRecord>;
/**
 * Maps the harness's resulting task statuses back onto the plan's own task list —
 * mirrors what adapter/harness/plan_store.py's task_graph_to_plan does for the
 * Python planner, just keyed to a chat session instead of a snapshot file. Marks
 * the plan 'done' once every task is COMPLETE, so loadActivePlan stops resuming it.
 * Also flips `executingOnPlan` back to false in that same allComplete branch (plan
 * mode's P4, INV-32) — one of exactly two places that happens, the other being
 * `abandonPlan`'s explicit user-abort path; every other event (a task failing, a
 * needs_approval/needs_clarification interrupt, a harness error) leaves it untouched.
 */
export declare function updatePlanFromRun(plan: PlanRecord, taskGraphTasks: {
    id: string;
    status: TaskStatus;
}[], taskNotes?: Record<string, string>): PlanRecord;
/** Cancelled tasks are excluded from both sides of the ratio — they're neither remaining work nor
 * something the user actually did, so counting them as "complete" would overstate real progress.
 * A plan with no tasks at all is 0% (unchanged); a plan whose remaining tasks were all cancelled
 * is 100% (nothing left to do) — two different situations, not the same "empty" case. */
export declare function planCompletionPct(plan: PlanRecord): number;
/**
 * Live, mid-run position within a durable plan — see the harness layer activation plan's
 * Phase 3.2. `stepIndex` is 1-based: the task currently RUNNING, or (once nothing is running)
 * the last COMPLETE task, or the first task before anything has started.
 */
export interface PlanPosition {
    templateName: string | null;
    stepIndex: number;
    stepCount: number;
    currentTaskDescription: string;
    completionPct: number;
}
/** Computes live plan position from a live (possibly mid-run) task-status list — `plan.tasks`' own order is authoritative; `taskGraphTasks` only supplies current status per id. */
export declare function computePlanPosition(plan: PlanRecord, taskGraphTasks: {
    id: string;
    status: TaskStatus;
}[]): PlanPosition | null;
/** The next not-yet-COMPLETE task in plan order — used to phrase a pause/resume prompt ("Ready to continue with: <description>?"). Returns null once every task is COMPLETE. */
export declare function nextPendingTask(plan: PlanRecord): PlanTaskRecord | null;
/** Human-readable plan status — mirrors the Python planner agent's format_plan_progress, for callers (the CLI) that want text instead of the structured planStatus field. */
export declare function formatPlanProgress(plan: PlanRecord): string;
export {};
