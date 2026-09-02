import type { Task } from '@buildaharness/harness'
import type { ILLMClient, TokenUsage, ReminderStore } from '@buildaharness/runtime'
import { classifyTurnIntent, type TurnIntentClassification } from './turn-intent-classifier.js'
import { looksLikeCodingFact } from './contradiction-checker.js'
import { reframeTaskDescriptionWithLLM } from './decomposition-classifier.js'
import { buildPlanFromTemplate } from './plan-builder.js'
import { loadTemplate } from './plan-templates/index.js'
import type { PlanRecord } from './plan-store.js'
import { PlanService } from './plan-service.js'
import { toHarnessTasks, toTaskRiskLevel, planTaskRiskLevel } from './task-mapping.js'
import type { AssistantTrace, AssistantTurnResult } from './assistant-types.js'

/**
 * The front portion of runTurn — plan-cancel-bypass detection, the classifyTurnIntent call, the
 * message-level risk-gate decision, and (via `resolveTasks`) decomposition/plan-template
 * resolution — as a pure decision-maker. Deliberately no MemoryAdapter/onTrace dependency beyond
 * what's passed as plain arguments/collaborators (PlanService, ReminderStore), so this stays
 * unit-testable without heavy mocks. Does NOT append to the transcript or call onTrace itself —
 * every variant below carries enough data for the sequencer (assistant.ts) to do both, in the
 * exact order the pre-split code did.
 */
export type TurnInterpretation =
  | {
      kind: 'bypass'
      result: AssistantTurnResult
      transcriptAppend: { user: string; assistant: string }
      planUpdatedTrace: { templateName: string; completionPct: number }
    }
  | { kind: 'needs_approval'; classification: TurnIntentClassification; result: AssistantTurnResult }
  | { kind: 'proceed'; classification: TurnIntentClassification; planForCancelCheck: PlanRecord | null }

export interface ResolvedTasks {
  initialTasks: Task[]
  activePlan: PlanRecord | null
  /** Only set when a NEW plan match was attempted this turn (i.e. no active plan was already being resumed) — mirrors the original code's `else` branch, which is the only place this trace fired. */
  planClassifiedTrace?: { isCandidate: boolean; matchedTemplate: string | null }
}

export class TurnInterpreter {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly planService: PlanService,
    private readonly reminderStore: ReminderStore,
  ) {}

  async interpretIntent(params: {
    userMessage: string
    sessionId: string
    toolLoopWillRun: boolean
    approved: boolean
    dangerouslySkipPermissions: boolean
    onUsage: (usage: TokenUsage) => void
  }): Promise<TurnInterpretation> {
    const { userMessage, sessionId, toolLoopWillRun, approved, dangerouslySkipPermissions, onUsage } = params

    // Per-task plan cancellation ("cancel the daily-budget task", "skip the research step") is
    // internal bookkeeping — it never touches anything outside this session's own plan state,
    // unlike a real-world "cancel my gym membership" — so it's handled here, before
    // classifyTurnIntent's single consolidated LLM call below ever runs: both because it's a
    // tighter, plan-aware match than a general risk gate should have to express, and because
    // short-circuiting here means a turn that's just cancelling one task doesn't spend the
    // consolidated call at all.
    const planForCancelCheck = await this.planService.loadActivePlan(sessionId)
    if (planForCancelCheck) {
      const cancelMatch = this.planService.matchTaskCancelAttempt(userMessage, planForCancelCheck)
      if (cancelMatch) {
        const updatedPlan = await this.planService.cancelPlanTask(sessionId, planForCancelCheck, cancelMatch.taskId)
        const next = this.planService.nextPendingTask(updatedPlan)
        const reply = next
          ? `Cancelled "${cancelMatch.taskDescription}". Continuing with the rest of the plan — next up: ${next.description}`
          : `Cancelled "${cancelMatch.taskDescription}". That was the last remaining task, so the plan is complete.`
        const completionPct = this.planService.planCompletionPct(updatedPlan)
        const skippedTrace: AssistantTrace = { nodeExecutionOrder: [], verificationHealth: { strength: 0, feasibility: 0 }, layerActivity: [] }
        const result: AssistantTurnResult = {
          status: 'ok',
          reply,
          riskLevel: 'LOW',
          stepsUsed: 0,
          harnessSkipped: true,
          trace: skippedTrace,
          planStatus: {
            templateName: updatedPlan.templateName,
            successCriteria: updatedPlan.successCriteria,
            completionPct,
            tasks: updatedPlan.tasks.map((t) => ({ id: t.id, description: t.description, status: t.cancelled ? 'CANCELLED' : t.status })),
          },
        }
        return {
          kind: 'bypass',
          result,
          transcriptAppend: { user: userMessage, assistant: reply },
          planUpdatedTrace: { templateName: updatedPlan.templateName, completionPct },
        }
      }
    }

    // Single consolidated LLM call replacing the former classifyRisk/classifyTriviality/
    // classifyDecompositionCandidate/isAbandonPhrase/classifyPlanningCandidate chain — see
    // turn-intent-classifier.ts.
    const classification = await classifyTurnIntent(userMessage, this.llmClient, { hasActivePlan: planForCancelCheck !== null }, this.model(), onUsage)

    // A reminder-shaped MEDIUM request stores a record immediately — detection, not action
    // gating, so it happens whether or not the rest of the turn is ultimately
    // approved/completed. v1 stores raw text with no time parsing (dueAt: null) — see
    // ReminderStore's doc comment.
    //
    // Only fires when no tool loop is coming up: whenever fileTools/webTools/shellTools is
    // configured, REMINDER_TOOLS is always offered to the model, so the model can and does call
    // create_reminder itself for the exact same message — storing the raw text here too produced
    // two records for one request. This pre-emptive store is a fallback for backends where no
    // tool loop ever runs at all, not a second insurance policy alongside one.
    //
    // requiresApproval here means this looks like a BULK reminder request — must not auto-create
    // anything until the approval gate below actually runs, or this would silently create a
    // reminder before the user ever sees the prompt.
    if (!toolLoopWillRun && classification.riskLevel === 'MEDIUM' && classification.isReminderRequest && !classification.requiresApproval) {
      await this.reminderStore.create(userMessage, null)
    }

    if (classification.requiresApproval && !approved && !dangerouslySkipPermissions) {
      // Deliberately not persisted to transcript — the outcome isn't known yet (a decline never
      // calls turn() again for this gate, unlike the pendingActionId gate, which always resolves
      // via ActionApprovalService) — see the sequencer for the full reasoning.
      return {
        kind: 'needs_approval',
        classification,
        result: { status: 'needs_approval', reply: null, reason: classification.riskReason, riskLevel: classification.riskLevel },
      }
    }

    return { kind: 'proceed', classification, planForCancelCheck }
  }

  /**
   * Decomposition/plan-template resolution — only meaningful (and only ever called by the
   * sequencer) once a turn is known NOT to be trivial, since a trivial turn returns before any
   * of this would matter and must not spend buildPlanFromTemplate's LLM call for nothing.
   */
  async resolveTasks(params: {
    userMessage: string
    sessionId: string
    classification: TurnIntentClassification
    planForCancelCheck: PlanRecord | null
    onUsage: (usage: TokenUsage) => void
  }): Promise<ResolvedTasks> {
    const { userMessage, sessionId, classification, planForCancelCheck, onUsage } = params

    // The single-task fallback — the raw userMessage verbatim as its description, unlike
    // classifyTurnIntent's own decomposedTasks/buildPlanFromTemplate, which already ask for a
    // subject-first description. Reusing that same phrasing here keeps the "Completed: <description>"
    // belief statementsOpposed/isNegation compare against structured consistently across every
    // task-creation path.
    let initialTasks: Task[] = toHarnessTasks([{ id: 'respond', description: userMessage, depends_on: [] }], toTaskRiskLevel(classification.riskLevel))
    const decomposed = classification.decomposedTasks
    if (decomposed) {
      initialTasks = toHarnessTasks(decomposed, toTaskRiskLevel(classification.riskLevel))
    }

    // Structured planning: an active plan for this session takes precedence over
    // re-classifying every turn, so an unrelated aside mid-plan doesn't get silently
    // reinterpreted as "start a new plan". classification.isAbandonRequest is only ever true
    // when planForCancelCheck (passed as context.hasActivePlan to classifyTurnIntent) was
    // non-null, so it's safe to act on unconditionally here.
    let activePlan: PlanRecord | null = planForCancelCheck
    if (activePlan && classification.isAbandonRequest) {
      await this.planService.abandonPlan(sessionId, activePlan)
      activePlan = null
    }

    let planClassifiedTrace: ResolvedTasks['planClassifiedTrace']
    if (activePlan) {
      initialTasks = toHarnessTasks(activePlan.tasks, planTaskRiskLevel)
    } else {
      planClassifiedTrace = { isCandidate: classification.matchedPlanTemplate !== null, matchedTemplate: classification.matchedPlanTemplate }
      if (classification.matchedPlanTemplate) {
        const template = loadTemplate(classification.matchedPlanTemplate)
        const plan = await buildPlanFromTemplate(this.llmClient, userMessage, template, this.model(), onUsage)
        if (plan) {
          activePlan = this.planService.createPlanRecord(plan)
          await this.planService.savePlan(sessionId, activePlan)
          initialTasks = toHarnessTasks(activePlan.tasks, planTaskRiskLevel)
        }
        // plan is null (malformed/insufficient LLM response): fall through to whatever
        // initialTasks decomposition already produced above, unchanged.
      }
    }

    // Gated by both looksLikeCodingFact AND riskLevel !== 'LOW' — looksLikeCodingFact alone is
    // too loose to gate a *new* LLM call on: it's a plain keyword list built for a lower-stakes
    // purpose, so common non-technical words it also happens to contain false-positive on
    // ordinary conversation. riskLevel !== 'LOW' isn't just a tighter filter — it's the actual
    // precondition for this to ever matter: harness-runtime.ts's world-model layer only writes a
    // "Completed: ..." trail belief from a single task (taskCount === 1, true here by
    // construction) when no fact was extracted from the turn *and* riskLevel !== 'LOW'.
    if (
      initialTasks.length === 1 &&
      initialTasks[0].id === 'respond' &&
      classification.riskLevel !== 'LOW' &&
      looksLikeCodingFact(userMessage)
    ) {
      const reframed = await reframeTaskDescriptionWithLLM(userMessage, this.llmClient, this.model(), onUsage)
      if (reframed) {
        initialTasks = toHarnessTasks([{ id: 'respond', description: reframed, depends_on: [] }], toTaskRiskLevel(classification.riskLevel))
      }
    }

    return { initialTasks, activePlan, planClassifiedTrace }
  }
}
