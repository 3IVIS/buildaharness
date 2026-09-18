import type { MemoryAdapter } from '@buildaharness/runtime'
import type { TaskStatus } from '@buildaharness/harness'
import type { Plan } from './plan-builder.js'
import {
  loadActivePlan,
  loadPlanRecord,
  createPlanRecord,
  createDraftPlanRecord,
  savePlan,
  abandonPlan,
  stagePlanForApproval,
  activatePlanRecord,
  updatePlanFromRun,
  planCompletionPct,
  computePlanPosition,
  nextPendingTask,
  matchTaskCancelAttempt,
  cancelPlanTask,
  editPlanTask,
  type PlanRecord,
  type PlanPosition,
  type TaskCancelMatch,
  type PlanFsPersistence,
} from './plan-store.js'

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
export class PlanService {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly fsPersistence?: PlanFsPersistence,
  ) {}

  loadActivePlan(sessionId: string): Promise<PlanRecord | null> {
    return loadActivePlan(this.memory, sessionId, this.fsPersistence)
  }

  /** Unlike loadActivePlan, returns the stored record regardless of `mode` — used by plan mode's P1 drafting loop, which needs to resume a `mode: 'drafting'` record loadActivePlan would never return. */
  loadPlanRecord(sessionId: string): Promise<PlanRecord | null> {
    return loadPlanRecord(this.memory, sessionId, this.fsPersistence)
  }

  createDraftPlanRecord(templateName: string | null): PlanRecord {
    return createDraftPlanRecord(templateName)
  }

  matchTaskCancelAttempt(message: string, plan: PlanRecord): TaskCancelMatch | null {
    return matchTaskCancelAttempt(message, plan)
  }

  cancelPlanTask(sessionId: string, plan: PlanRecord, taskId: string): Promise<PlanRecord> {
    return cancelPlanTask(this.memory, sessionId, plan, taskId, this.fsPersistence)
  }

  editPlanTask(sessionId: string, plan: PlanRecord, taskId: string, newDescription: string): Promise<PlanRecord> {
    return editPlanTask(this.memory, sessionId, plan, taskId, newDescription, this.fsPersistence)
  }

  abandonPlan(sessionId: string, plan: PlanRecord): Promise<void> {
    return abandonPlan(this.memory, sessionId, plan, this.fsPersistence)
  }

  stagePlanForApproval(sessionId: string, plan: PlanRecord): Promise<PlanRecord> {
    return stagePlanForApproval(this.memory, sessionId, plan, this.fsPersistence)
  }

  activatePlanRecord(sessionId: string, plan: PlanRecord): Promise<PlanRecord> {
    return activatePlanRecord(this.memory, sessionId, plan, this.fsPersistence)
  }

  savePlan(sessionId: string, plan: PlanRecord): Promise<void> {
    return savePlan(this.memory, sessionId, plan, this.fsPersistence)
  }

  createPlanRecord(plan: Plan): PlanRecord {
    return createPlanRecord(plan)
  }

  updatePlanFromRun(plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): PlanRecord {
    return updatePlanFromRun(plan, taskGraphTasks)
  }

  planCompletionPct(plan: PlanRecord): number {
    return planCompletionPct(plan)
  }

  computePlanPosition(plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): PlanPosition | null {
    return computePlanPosition(plan, taskGraphTasks)
  }

  nextPendingTask(plan: PlanRecord): ReturnType<typeof nextPendingTask> {
    return nextPendingTask(plan)
  }

  /** Persists `plan`'s current task statuses and returns the AssistantTurnResult.planStatus shape both the paused and success branches of ResponseService build identically. */
  async saveAndSummarize(sessionId: string, plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): Promise<{ plan: PlanRecord; completionPct: number; planStatus: { templateName: string | null; successCriteria: string; completionPct: number; tasks: { id: string; description: string; status: string }[] } }> {
    const updated = this.updatePlanFromRun(plan, taskGraphTasks)
    await this.savePlan(sessionId, updated)
    const completionPct = this.planCompletionPct(updated)
    return {
      plan: updated,
      completionPct,
      planStatus: {
        templateName: updated.templateName,
        successCriteria: updated.successCriteria,
        completionPct,
        tasks: updated.tasks.map((t) => ({ id: t.id, description: t.description, status: t.status })),
      },
    }
  }
}
