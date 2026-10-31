import { MemoryAdapter } from '@buildaharness/runtime';
import { TaskStatus } from '@buildaharness/harness';
import { Plan } from './plan-builder.js';
import { nextPendingTask, PlanRecord, PlanPosition, TaskCancelMatch, PlanFsPersistence } from './plan-store.js';
/**
 * Thin constructor-scoped facade over `memory` for durable-plan bookkeeping — plan-store.ts (and
 * plan-builder.ts/plan-templates/, untouched by this split) already hold the real logic, so this
 * module exists only so TurnInterpreter, HarnessBridge (mid-run `onCheckpoint`), and
 * ResponseService (post-run planStatus assembly) share one collaborator instead of each importing
 * plan-store.ts's free functions directly and threading `memory` themselves.
 *
 * `fsPersistence` (plan mode's P5) is the same `{backend, workspaceRoot}` pair
 * AssistantSession.undoWorkspace() resolves for write_file/run_shell_command — `undefined` on a
 * surface with no real filesystem (e.g. a browser tab), in which case every method below behaves
 * exactly as it did before P5, Dexie-only.
 */
export declare class PlanService {
    private readonly memory;
    private readonly fsPersistence?;
    constructor(memory: MemoryAdapter, fsPersistence?: PlanFsPersistence | undefined);
    loadActivePlan(sessionId: string): Promise<PlanRecord | null>;
    /** Unlike loadActivePlan, returns the stored record regardless of `mode` — used by plan mode's P1 drafting loop, which needs to resume a `mode: 'drafting'` record loadActivePlan would never return. */
    loadPlanRecord(sessionId: string): Promise<PlanRecord | null>;
    createDraftPlanRecord(templateName: string | null): PlanRecord;
    matchTaskCancelAttempt(message: string, plan: PlanRecord): TaskCancelMatch | null;
    cancelPlanTask(sessionId: string, plan: PlanRecord, taskId: string): Promise<PlanRecord>;
    editPlanTask(sessionId: string, plan: PlanRecord, taskId: string, newDescription: string): Promise<PlanRecord>;
    abandonPlan(sessionId: string, plan: PlanRecord): Promise<void>;
    stagePlanForApproval(sessionId: string, plan: PlanRecord): Promise<PlanRecord>;
    activatePlanRecord(sessionId: string, plan: PlanRecord): Promise<PlanRecord>;
    savePlan(sessionId: string, plan: PlanRecord): Promise<void>;
    createPlanRecord(plan: Plan): PlanRecord;
    updatePlanFromRun(plan: PlanRecord, taskGraphTasks: {
        id: string;
        status: TaskStatus;
    }[], taskNotes?: Record<string, string>): PlanRecord;
    planCompletionPct(plan: PlanRecord): number;
    computePlanPosition(plan: PlanRecord, taskGraphTasks: {
        id: string;
        status: TaskStatus;
    }[]): PlanPosition | null;
    nextPendingTask(plan: PlanRecord): ReturnType<typeof nextPendingTask>;
    /** Persists `plan`'s current task statuses and returns the AssistantTurnResult.planStatus shape both the paused and success branches of ResponseService build identically. */
    saveAndSummarize(sessionId: string, plan: PlanRecord, taskGraphTasks: {
        id: string;
        status: TaskStatus;
    }[], taskNotes?: Record<string, string>): Promise<{
        plan: PlanRecord;
        completionPct: number;
        planStatus: {
            templateName: string | null;
            successCriteria: string;
            completionPct: number;
            tasks: {
                id: string;
                description: string;
                status: string;
                note?: string;
                dependsOn?: string[];
                cancelled?: boolean;
                riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
            }[];
        };
    }>;
}
