import type { AssistantSession } from './assistant-session.js'
import type { PlanService } from './plan-service.js'
import type { PlanRecord } from './plan-store.js'
import type { AssistantTurnResult } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'

/**
 * `'approve_trusted'` (plan mode's P10) is structurally its own decision, not a modifier on
 * `'approve'`/`'approve_with_edits'` — it carries no `edits` of its own and, like plain
 * `'approve'`, activates the plan as staged, just with `PlanRecord.trustApprovedSteps` also set
 * (see resolvePendingPlanApproval below and INV-36).
 */
export type PlanDecision = 'approve' | 'approve_trusted' | 'approve_with_edits' | 'decline'

export interface PlanApprovalEdits {
  cancelTaskIds?: string[]
  editedTasks?: { id: string; description: string }[]
}

/**
 * `PlanApprovalService.resolvePendingPlanApproval`'s result: either a terminal
 * `AssistantTurnResult` (stale/missing staged plan, no decision supplied, or a failed
 * approve/approve-with-edits — fail closed, `mode` left exactly as staged) or `{ fallThrough:
 * true }`, meaning the plan record has already been updated (activated, or discarded) and
 * `assistant.ts`'s `runTurn` should keep going with the *same originating message* through the
 * ordinary pipeline below, per this phase's own scope: approve lets that pipeline pick up the
 * now-`active` plan exactly the way a freshly template-matched plan already does today
 * (`TurnInterpreter.resolveTasks` -> `loadActivePlan` -> `initialTasks`, regardless of what the
 * message itself says, short of a cancel/abandon match) — no new execution-driving code needed,
 * just reusing what already runs a plan's first task the moment it becomes `active`. Decline
 * falls through the same way, but with no plan active at all.
 */
export type PlanApprovalOutcome = { fallThrough: true } | AssistantTurnResult

function snapshotOf(plan: PlanRecord): NonNullable<AssistantTurnResult['planApproval']> {
  return {
    templateName: plan.templateName,
    successCriteria: plan.successCriteria,
    rationale: plan.rationale,
    tasks: plan.tasks.map((t) => ({ id: t.id, description: t.description, riskLevel: t.riskLevel })),
    reviewNotes: plan.reviewNotes,
  }
}

/**
 * Owns plan mode's P2 mandatory whole-plan approval gate — mirrors ActionApprovalService's
 * "resolved by ID, never re-derived" staging pattern (T4 of the file-tools plan), the same model
 * AskClarificationService (Q2) already follows. Every drafted plan passes through here exactly
 * once, regardless of risk (Section 5b-2: no risk-tiered skip) — `PlanDraftingService` calls
 * `stageAndRespond` the moment a revision's `readyForApproval` is true, and
 * `assistant.ts`'s `runTurn` calls `resolvePendingPlanApproval` whenever a turn carries a
 * `planApprovalId`, before `planMode.active` is even checked (mirrors where `pendingActionId`/
 * `pendingClarificationId` are checked).
 */
export class PlanApprovalService {
  constructor(
    private readonly planService: PlanService,
    private readonly session: AssistantSession,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
  ) {}

  /** Stages `plan` for approval and returns the `needs_plan_approval` result — the PlanDraftingService counterpart to AskClarificationService.stageAndRespond. */
  async stageAndRespond(sessionId: string, transcriptKey: string, plan: PlanRecord, userMessage: string): Promise<AssistantTurnResult> {
    const staged = await this.planService.stagePlanForApproval(sessionId, plan)
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    this.onTrace?.({ kind: 'escalation', reason: `needs_plan_approval: ${staged.tasks.length} task(s) staged for approval` })
    return {
      status: 'needs_plan_approval',
      reply: null,
      planApprovalId: staged.planApprovalId,
      planApproval: snapshotOf(staged),
    }
  }

  /**
   * Resolves a staged plan by ID — validates it's still exactly the plan that was staged (a
   * stale/unknown `planApprovalId` resolves to a no-op `ok`, same as
   * AskClarificationService.resolvePendingClarification's own stale-ID handling), then applies
   * the caller's decision. Fail-closed (Protected Invariants) on every failure path: no decision,
   * or a throwing edit/activation step, leaves `mode: 'awaiting_approval'` untouched and returns a
   * new `needs_plan_approval` result rather than silently advancing or discarding the plan.
   */
  async resolvePendingPlanApproval(
    sessionId: string,
    planApprovalId: string,
    decision: PlanDecision | undefined,
    edits: PlanApprovalEdits | undefined,
  ): Promise<PlanApprovalOutcome> {
    const staged = await this.planService.loadPlanRecord(sessionId)
    if (!staged || staged.mode !== 'awaiting_approval' || staged.planApprovalId !== planApprovalId) {
      return { status: 'ok', reply: 'That plan is no longer pending approval — nothing to resolve.' }
    }

    if (!decision) {
      return {
        status: 'needs_plan_approval',
        reply: null,
        reason: 'No decision was provided.',
        planApprovalId,
        planApproval: snapshotOf(staged),
      }
    }

    if (decision === 'decline') {
      await this.planService.abandonPlan(sessionId, staged)
      await this.session.exitPlanMode(sessionId)
      return { fallThrough: true }
    }

    try {
      let working = staged
      if (decision === 'approve_with_edits' && edits) {
        for (const taskId of edits.cancelTaskIds ?? []) {
          if (!working.tasks.some((t) => t.id === taskId)) throw new Error(`Unknown task id: ${taskId}`)
          working = await this.planService.cancelPlanTask(sessionId, working, taskId)
        }
        for (const edit of edits.editedTasks ?? []) {
          if (!working.tasks.some((t) => t.id === edit.id)) throw new Error(`Unknown task id: ${edit.id}`)
          working = await this.planService.editPlanTask(sessionId, working, edit.id, edit.description)
        }
      }
      // P10: the one narrow, explicit, per-plan opt-in exception to "write/shell stay gated by
      // default" (Protected Invariants) — see PlanRecord.trustApprovedSteps's doc comment and
      // INV-36. Never set for plain 'approve'/'approve_with_edits'.
      if (decision === 'approve_trusted') {
        working = { ...working, trustApprovedSteps: true }
      }
      await this.planService.activatePlanRecord(sessionId, working)
    } catch {
      // Fail-closed: activatePlanRecord is always the last call in the try block, so a throw
      // anywhere above means the plan record on disk is still whatever cancelPlanTask/
      // editPlanTask last wrote (still `mode: 'awaiting_approval'`) — never `active`.
      const current = (await this.planService.loadPlanRecord(sessionId)) ?? staged
      return {
        status: 'needs_plan_approval',
        reply: null,
        reason: "Couldn't apply the approval — the plan is still awaiting approval.",
        planApprovalId,
        planApproval: snapshotOf(current),
      }
    }

    await this.session.exitPlanMode(sessionId)
    return { fallThrough: true }
  }
}
