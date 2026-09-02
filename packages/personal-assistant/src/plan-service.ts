import type { MemoryAdapter } from '@buildaharness/runtime'
import type { TaskStatus } from '@buildaharness/harness'
import type { Plan } from './plan-builder.js'
import {
  loadActivePlan,
  createPlanRecord,
  savePlan,
  abandonPlan,
  updatePlanFromRun,
  planCompletionPct,
  computePlanPosition,
  nextPendingTask,
  matchTaskCancelAttempt,
  cancelPlanTask,
  type PlanRecord,
  type PlanPosition,
  type TaskCancelMatch,
} from './plan-store.js'

/**
 * Thin constructor-scoped facade over `memory` for durable-plan bookkeeping — plan-store.ts (and
 * plan-builder.ts/plan-templates/, untouched by this split) already hold the real logic, so this
 * module exists only so TurnInterpreter, HarnessBridge (mid-run `onCheckpoint`), and
 * ResponseService (post-run planStatus assembly) share one collaborator instead of each importing
 * plan-store.ts's free functions directly and threading `memory` themselves.
 */
export class PlanService {
  constructor(private readonly memory: MemoryAdapter) {}

  loadActivePlan(sessionId: string): Promise<PlanRecord | null> {
    return loadActivePlan(this.memory, sessionId)
  }

  matchTaskCancelAttempt(message: string, plan: PlanRecord): TaskCancelMatch | null {
    return matchTaskCancelAttempt(message, plan)
  }

  cancelPlanTask(sessionId: string, plan: PlanRecord, taskId: string): Promise<PlanRecord> {
    return cancelPlanTask(this.memory, sessionId, plan, taskId)
  }

  abandonPlan(sessionId: string, plan: PlanRecord): Promise<void> {
    return abandonPlan(this.memory, sessionId, plan)
  }

  savePlan(sessionId: string, plan: PlanRecord): Promise<void> {
    return savePlan(this.memory, sessionId, plan)
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
  async saveAndSummarize(sessionId: string, plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): Promise<{ plan: PlanRecord; completionPct: number; planStatus: { templateName: string; successCriteria: string; completionPct: number; tasks: { id: string; description: string; status: string }[] } }> {
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
