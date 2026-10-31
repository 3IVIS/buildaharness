import { z } from 'zod';
import { MemoryAdapter } from '@buildaharness/runtime';
import { PlanFsPersistence, PlanRecord } from './plan-store.js';
export declare const GoalThreadStatusSchema: z.ZodEnum<["READY", "ACTIVE", "BLOCKED", "PAUSED", "DONE", "ABANDONED"]>;
export type GoalThreadStatus = z.infer<typeof GoalThreadStatusSchema>;
/**
 * R3's two reasons for multiple root nodes, handled oppositely: `alternative` roots are competing
 * guesses at one intent (resolving one abandons the others), `concurrent` roots are genuinely
 * separate goals that coexist. Absent for a thread with no siblings needing disambiguation.
 */
export declare const SiblingRelationSchema: z.ZodEnum<["alternative", "concurrent"]>;
export type SiblingRelation = z.infer<typeof SiblingRelationSchema>;
declare const GoalTaskRecordSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    depends_on: z.ZodArray<z.ZodString, "many">;
    status: z.ZodEnum<["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]>;
    riskLevel: z.ZodOptional<z.ZodEnum<["LOW", "MEDIUM", "HIGH"]>>;
    cancelled: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string;
    status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
    description: string;
    depends_on: string[];
    riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
    cancelled?: boolean | undefined;
}, {
    id: string;
    status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
    description: string;
    depends_on: string[];
    riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
    cancelled?: boolean | undefined;
}>;
export type GoalTaskRecord = z.infer<typeof GoalTaskRecordSchema>;
/**
 * A persisted next-step suggestion (R7) — what next-step-proposer.ts's `proposeNextSteps()` yields
 * for a thread that just reached DONE, minus `goalThreadId` (it lives on the thread that owns it).
 * Advisory only: a suggestion is never a task on the thread and is never executed; the user acts on
 * it, if at all, by simply asking. `promotion` records the confidence policy that admitted it
 * (`auto` = high confidence, `pending_confirm` = medium); `session_only` (low confidence)
 * suggestions are never persisted, so they don't appear here.
 */
export declare const ThreadSuggestionSchema: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    rationale: z.ZodString;
    confidence: z.ZodEnum<["high", "medium", "low"]>;
    promotion: z.ZodEnum<["auto", "pending_confirm", "session_only"]>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    rationale: string;
    id: string;
    confidence: "high" | "medium" | "low";
    description: string;
    createdAt: string;
    promotion: "auto" | "pending_confirm" | "session_only";
}, {
    rationale: string;
    id: string;
    confidence: "high" | "medium" | "low";
    description: string;
    createdAt: string;
    promotion: "auto" | "pending_confirm" | "session_only";
}>;
export type ThreadSuggestion = z.infer<typeof ThreadSuggestionSchema>;
/**
 * One node in the persisted goal DAG (R2). Absorbs PlanRecord's exact shape (Q1) — templateName
 * through updatedAt below are unchanged in meaning from PlanRecord — plus the fields that make a
 * thread schedulable: a stable `id` (PlanRecord had none, being a singleton), a scheduler-facing
 * `status` distinct from `mode` (which is about this thread's own Tier-2 drafting/approval
 * lifecycle, not whether the Scheduler may currently give it focus — see INV-40), and R3's sibling
 * relation for when this thread is one of several roots.
 */
export declare const GoalThreadSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<["READY", "ACTIVE", "BLOCKED", "PAUSED", "DONE", "ABANDONED"]>;
    relationToSiblings: z.ZodOptional<z.ZodEnum<["alternative", "concurrent"]>>;
    /** Sibling GoalThread ids this one is grouped with as competing/concurrent roots (R3). */
    siblingIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** templateName..updatedAt: absorbed from PlanRecord unchanged (Q1). */
    templateName: z.ZodNullable<z.ZodString>;
    successCriteria: z.ZodString;
    rationale: z.ZodString;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        depends_on: z.ZodArray<z.ZodString, "many">;
        status: z.ZodEnum<["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]>;
        riskLevel: z.ZodOptional<z.ZodEnum<["LOW", "MEDIUM", "HIGH"]>>;
        cancelled: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        depends_on: string[];
        riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
        cancelled?: boolean | undefined;
    }, {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        depends_on: string[];
        riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
        cancelled?: boolean | undefined;
    }>, "many">;
    mode: z.ZodEnum<["drafting", "awaiting_approval", "active", "done", "abandoned"]>;
    reviewNotes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    verifiedAt: z.ZodOptional<z.ZodString>;
    executingOnPlan: z.ZodBoolean;
    /** Advisory next steps proposed when this thread reached DONE — see ThreadSuggestionSchema. */
    suggestions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        rationale: z.ZodString;
        confidence: z.ZodEnum<["high", "medium", "low"]>;
        promotion: z.ZodEnum<["auto", "pending_confirm", "session_only"]>;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        rationale: string;
        id: string;
        confidence: "high" | "medium" | "low";
        description: string;
        createdAt: string;
        promotion: "auto" | "pending_confirm" | "session_only";
    }, {
        rationale: string;
        id: string;
        confidence: "high" | "medium" | "low";
        description: string;
        createdAt: string;
        promotion: "auto" | "pending_confirm" | "session_only";
    }>, "many">>;
    trustApprovedSteps: z.ZodOptional<z.ZodBoolean>;
    planApprovalId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    rationale: string;
    id: string;
    status: "BLOCKED" | "READY" | "ACTIVE" | "PAUSED" | "DONE" | "ABANDONED";
    tasks: {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        depends_on: string[];
        riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
        cancelled?: boolean | undefined;
    }[];
    successCriteria: string;
    mode: "active" | "done" | "drafting" | "awaiting_approval" | "abandoned";
    createdAt: string;
    templateName: string | null;
    executingOnPlan: boolean;
    updatedAt: string;
    relationToSiblings?: "alternative" | "concurrent" | undefined;
    siblingIds?: string[] | undefined;
    reviewNotes?: string[] | undefined;
    verifiedAt?: string | undefined;
    suggestions?: {
        rationale: string;
        id: string;
        confidence: "high" | "medium" | "low";
        description: string;
        createdAt: string;
        promotion: "auto" | "pending_confirm" | "session_only";
    }[] | undefined;
    trustApprovedSteps?: boolean | undefined;
    planApprovalId?: string | undefined;
}, {
    rationale: string;
    id: string;
    status: "BLOCKED" | "READY" | "ACTIVE" | "PAUSED" | "DONE" | "ABANDONED";
    tasks: {
        id: string;
        status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
        description: string;
        depends_on: string[];
        riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
        cancelled?: boolean | undefined;
    }[];
    successCriteria: string;
    mode: "active" | "done" | "drafting" | "awaiting_approval" | "abandoned";
    createdAt: string;
    templateName: string | null;
    executingOnPlan: boolean;
    updatedAt: string;
    relationToSiblings?: "alternative" | "concurrent" | undefined;
    siblingIds?: string[] | undefined;
    reviewNotes?: string[] | undefined;
    verifiedAt?: string | undefined;
    suggestions?: {
        rationale: string;
        id: string;
        confidence: "high" | "medium" | "low";
        description: string;
        createdAt: string;
        promotion: "auto" | "pending_confirm" | "session_only";
    }[] | undefined;
    trustApprovedSteps?: boolean | undefined;
    planApprovalId?: string | undefined;
}>;
export type GoalThread = z.infer<typeof GoalThreadSchema>;
/**
 * The persisted DAG itself (R2): `threads` is the full set of goal threads known this session,
 * `activeThreadId` is the O(1) current-focus pointer every downstream mechanism (classifier,
 * Scheduler, next-step proposer, Tier-2 scoping) needs answerable without a graph traversal —
 * see the "current-focus / task→goal linkage primitive" gap this plan's design brief calls out.
 * INV-38/39 (at most one ACTIVE thread, Scheduler is the sole writer of this pointer) are enforced
 * starting Phase 5, not here — this phase only defines the shape.
 */
export declare const GoalGraphRecordSchema: z.ZodObject<{
    threads: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodEnum<["READY", "ACTIVE", "BLOCKED", "PAUSED", "DONE", "ABANDONED"]>;
        relationToSiblings: z.ZodOptional<z.ZodEnum<["alternative", "concurrent"]>>;
        /** Sibling GoalThread ids this one is grouped with as competing/concurrent roots (R3). */
        siblingIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        /** templateName..updatedAt: absorbed from PlanRecord unchanged (Q1). */
        templateName: z.ZodNullable<z.ZodString>;
        successCriteria: z.ZodString;
        rationale: z.ZodString;
        tasks: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            description: z.ZodString;
            depends_on: z.ZodArray<z.ZodString, "many">;
            status: z.ZodEnum<["PENDING", "RUNNING", "COMPLETE", "FAILED", "BLOCKED", "HUMAN_REQUIRED"]>;
            riskLevel: z.ZodOptional<z.ZodEnum<["LOW", "MEDIUM", "HIGH"]>>;
            cancelled: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
            description: string;
            depends_on: string[];
            riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
            cancelled?: boolean | undefined;
        }, {
            id: string;
            status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
            description: string;
            depends_on: string[];
            riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
            cancelled?: boolean | undefined;
        }>, "many">;
        mode: z.ZodEnum<["drafting", "awaiting_approval", "active", "done", "abandoned"]>;
        reviewNotes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        verifiedAt: z.ZodOptional<z.ZodString>;
        executingOnPlan: z.ZodBoolean;
        /** Advisory next steps proposed when this thread reached DONE — see ThreadSuggestionSchema. */
        suggestions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            description: z.ZodString;
            rationale: z.ZodString;
            confidence: z.ZodEnum<["high", "medium", "low"]>;
            promotion: z.ZodEnum<["auto", "pending_confirm", "session_only"]>;
            createdAt: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            rationale: string;
            id: string;
            confidence: "high" | "medium" | "low";
            description: string;
            createdAt: string;
            promotion: "auto" | "pending_confirm" | "session_only";
        }, {
            rationale: string;
            id: string;
            confidence: "high" | "medium" | "low";
            description: string;
            createdAt: string;
            promotion: "auto" | "pending_confirm" | "session_only";
        }>, "many">>;
        trustApprovedSteps: z.ZodOptional<z.ZodBoolean>;
        planApprovalId: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        rationale: string;
        id: string;
        status: "BLOCKED" | "READY" | "ACTIVE" | "PAUSED" | "DONE" | "ABANDONED";
        tasks: {
            id: string;
            status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
            description: string;
            depends_on: string[];
            riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
            cancelled?: boolean | undefined;
        }[];
        successCriteria: string;
        mode: "active" | "done" | "drafting" | "awaiting_approval" | "abandoned";
        createdAt: string;
        templateName: string | null;
        executingOnPlan: boolean;
        updatedAt: string;
        relationToSiblings?: "alternative" | "concurrent" | undefined;
        siblingIds?: string[] | undefined;
        reviewNotes?: string[] | undefined;
        verifiedAt?: string | undefined;
        suggestions?: {
            rationale: string;
            id: string;
            confidence: "high" | "medium" | "low";
            description: string;
            createdAt: string;
            promotion: "auto" | "pending_confirm" | "session_only";
        }[] | undefined;
        trustApprovedSteps?: boolean | undefined;
        planApprovalId?: string | undefined;
    }, {
        rationale: string;
        id: string;
        status: "BLOCKED" | "READY" | "ACTIVE" | "PAUSED" | "DONE" | "ABANDONED";
        tasks: {
            id: string;
            status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
            description: string;
            depends_on: string[];
            riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
            cancelled?: boolean | undefined;
        }[];
        successCriteria: string;
        mode: "active" | "done" | "drafting" | "awaiting_approval" | "abandoned";
        createdAt: string;
        templateName: string | null;
        executingOnPlan: boolean;
        updatedAt: string;
        relationToSiblings?: "alternative" | "concurrent" | undefined;
        siblingIds?: string[] | undefined;
        reviewNotes?: string[] | undefined;
        verifiedAt?: string | undefined;
        suggestions?: {
            rationale: string;
            id: string;
            confidence: "high" | "medium" | "low";
            description: string;
            createdAt: string;
            promotion: "auto" | "pending_confirm" | "session_only";
        }[] | undefined;
        trustApprovedSteps?: boolean | undefined;
        planApprovalId?: string | undefined;
    }>, "many">;
    activeThreadId: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    createdAt: string;
    updatedAt: string;
    threads: {
        rationale: string;
        id: string;
        status: "BLOCKED" | "READY" | "ACTIVE" | "PAUSED" | "DONE" | "ABANDONED";
        tasks: {
            id: string;
            status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
            description: string;
            depends_on: string[];
            riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
            cancelled?: boolean | undefined;
        }[];
        successCriteria: string;
        mode: "active" | "done" | "drafting" | "awaiting_approval" | "abandoned";
        createdAt: string;
        templateName: string | null;
        executingOnPlan: boolean;
        updatedAt: string;
        relationToSiblings?: "alternative" | "concurrent" | undefined;
        siblingIds?: string[] | undefined;
        reviewNotes?: string[] | undefined;
        verifiedAt?: string | undefined;
        suggestions?: {
            rationale: string;
            id: string;
            confidence: "high" | "medium" | "low";
            description: string;
            createdAt: string;
            promotion: "auto" | "pending_confirm" | "session_only";
        }[] | undefined;
        trustApprovedSteps?: boolean | undefined;
        planApprovalId?: string | undefined;
    }[];
    activeThreadId: string | null;
}, {
    createdAt: string;
    updatedAt: string;
    threads: {
        rationale: string;
        id: string;
        status: "BLOCKED" | "READY" | "ACTIVE" | "PAUSED" | "DONE" | "ABANDONED";
        tasks: {
            id: string;
            status: "BLOCKED" | "HUMAN_REQUIRED" | "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
            description: string;
            depends_on: string[];
            riskLevel?: "HIGH" | "MEDIUM" | "LOW" | undefined;
            cancelled?: boolean | undefined;
        }[];
        successCriteria: string;
        mode: "active" | "done" | "drafting" | "awaiting_approval" | "abandoned";
        createdAt: string;
        templateName: string | null;
        executingOnPlan: boolean;
        updatedAt: string;
        relationToSiblings?: "alternative" | "concurrent" | undefined;
        siblingIds?: string[] | undefined;
        reviewNotes?: string[] | undefined;
        verifiedAt?: string | undefined;
        suggestions?: {
            rationale: string;
            id: string;
            confidence: "high" | "medium" | "low";
            description: string;
            createdAt: string;
            promotion: "auto" | "pending_confirm" | "session_only";
        }[] | undefined;
        trustApprovedSteps?: boolean | undefined;
        planApprovalId?: string | undefined;
    }[];
    activeThreadId: string | null;
}>;
export type GoalGraphRecord = z.infer<typeof GoalGraphRecordSchema>;
/** Same `{backend, workspaceRoot}` pair as PlanFsPersistence — a goal graph and its session's plan file live in the same workspace. */
export type GoalGraphFsPersistence = PlanFsPersistence;
/**
 * Wraps an existing `PlanRecord` into the single `GoalThread` it becomes under Q1's "absorb, don't
 * duplicate" resolution — nothing in `plan`'s own fields is dropped.
 */
export declare function createGoalThreadFromPlanRecord(plan: PlanRecord, id?: string): GoalThread;
/** A fresh, empty goal graph — no threads, nothing active. */
export declare function createEmptyGoalGraphRecord(): GoalGraphRecord;
/** Wraps a single pre-existing `PlanRecord` into a one-thread `GoalGraphRecord` — the migration path's output shape. */
export declare function createGoalGraphRecordFromPlanRecord(plan: PlanRecord): GoalGraphRecord;
/**
 * R2's O(1) locatability primitive, live as of Phase 4: the currently-focused thread, found by a
 * direct field lookup (`activeThreadId`), never a graph traversal. Defensive about a transient
 * inconsistency Phase 4 can produce (see goal-graph-reconcile.ts): a NEW_GOAL/CANCEL_CURRENT
 * steering message can pause/abandon the thread `activeThreadId` still points at, ahead of Phase
 * 5's Scheduler ever reassigning that pointer (INV-39 — only the Scheduler writes it) — so this
 * only returns a thread whose own `status` is still genuinely `ACTIVE`, not just pointed-at.
 */
export declare function getActiveThread(record: GoalGraphRecord): GoalThread | null;
/** R2's task→goal parent-link query — every task belonging to `goalId`, a direct field filter, never a traversal. */
export declare function tasksForGoal(record: GoalGraphRecord, goalId: string): GoalTaskRecord[];
/**
 * Every thread the Scheduler could hand focus to right now (Phase 5): READY, and not mid-Tier-2
 * drafting or awaiting approval (INV-40). A drafting thread's `status` is READY (see
 * createGoalThreadFromPlanRecord / mintConcurrentReadyThread), so the exclusion has to look at
 * `mode`, not just `status` — until 2026-09-23 this filtered on status alone, which quietly made
 * INV-40 false: a thread minted by a NEW_GOAL steering message (mode 'drafting') was eligible for
 * focus. The identity matcher (goal-thread-identity.ts) is what adopts such a thread, by matching
 * a real turn to it and promoting its mode to 'active'.
 */
export declare function readyThreads(record: GoalGraphRecord): GoalThread[];
/**
 * R4's NEW_GOAL branch (both IMMEDIATE and DEFERRED collapse to this in Phase 4 — see
 * check-caller-updates.ts's cancel_current sibling doc comment and the plan's resolved
 * "ACTIVE-pointer write authority" decision: Tier-1 never writes `activeThreadId` itself, it only
 * pauses the old thread and mints the new one READY; Phase 5's Scheduler decides what becomes
 * ACTIVE next). `pauseThreadId`, when given and currently ACTIVE, transitions to PAUSED and is
 * linked to the new thread as a `concurrent` sibling (R3) — never `alternative`, since a NEW_GOAL
 * is a genuinely separate objective, not a competing guess at the same one.
 */
export declare function mintConcurrentReadyThread(record: GoalGraphRecord, description: string, pauseThreadId?: string | null): GoalGraphRecord;
/** R4's CANCEL_CURRENT branch — marks a thread ABANDONED. Kept for audit trail, never removed from `threads`. */
export declare function abandonThread(record: GoalGraphRecord, threadId: string): GoalGraphRecord;
export declare function saveGoalGraphRecord(memory: MemoryAdapter, sessionId: string, record: GoalGraphRecord, fsPersistence?: GoalGraphFsPersistence): Promise<void>;
/**
 * Removes `sessionId`'s goal graph from memory and, when configured, its JSON file (the file wins over the memory record on load, so
 * deleting only the record would bring the old goals straight back). Used when a conversation ends: a fresh conversation must not keep
 * the old one's goals or the next steps saved on them. Never throws.
 */
export declare function deleteGoalGraphRecord(memory: MemoryAdapter, sessionId: string, fsPersistence?: GoalGraphFsPersistence): Promise<void>;
/**
 * Loads `sessionId`'s goal graph, migrating a pre-existing `PlanRecord` in place the first time
 * this is called for a session that predates this mechanism (P5-equivalent non-destructive
 * discipline — same as `migrateFact`/`migratePlanRecord`: the old record's data is never silently
 * dropped, just re-shaped and persisted once under the new key). Every call after that first one
 * finds the migrated `GoalGraphRecord` directly and never re-touches the legacy `PlanRecord`.
 *
 * When `fsPersistence` is configured and its goal-graph JSON file exists, that file wins over the
 * Dexie/State-tier record, mirroring `loadPlanRecord`'s own fs-file-wins-then-reconcile behavior
 * (INV-33's discipline, applied here too: the result is written back into `memory` so the two
 * never stay silently split).
 */
export declare function loadGoalGraphRecord(memory: MemoryAdapter, sessionId: string, fsPersistence?: GoalGraphFsPersistence): Promise<GoalGraphRecord | null>;
/**
 * Appends advisory `suggestions` to `threadId`, skipping any whose description (case-insensitive,
 * trimmed) the thread already carries — proposing again for the same DONE thread must not stack
 * duplicates. `session_only` suggestions are dropped here (low confidence is advisory for the turn
 * that produced it, never persisted). A `threadId` not present in `record.threads` is a no-op.
 */
export declare function addThreadSuggestions(record: GoalGraphRecord, threadId: string, suggestions: ThreadSuggestion[]): GoalGraphRecord;
export {};
