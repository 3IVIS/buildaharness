import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { testAny, getPlanModeCancelPatterns } from './lexical/patterns.js'
import { draftPlanRevision } from './plan-drafting.js'
import type { PlanRecord, PlanTaskRecord } from './plan-store.js'
import type { AssistantSession } from './assistant-session.js'
import type { PlanService } from './plan-service.js'
import type { AssistantTurnResult } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'

const { cancelVerbs, planningReferenceMarker } = getPlanModeCancelPatterns()

/** Both an explicit cancel-shaped verb AND a reference to planning/drafting must match — same both-markers-required discipline plan-store.ts's matchTaskCancelAttempt uses, so an unrelated "cancel my flight" said mid-draft doesn't spuriously exit plan mode. */
function isCancelPlanningPhrase(message: string): boolean {
  return testAny(cancelVerbs, message) && testAny(planningReferenceMarker, message)
}

/**
 * Owns plan mode's P1 exclusive drafting loop: while `AssistantSession.getPlanModeState(sessionId)`
 * is `active`, `assistant.ts`'s runTurn routes every message here instead of TurnInterpreter's
 * normal classify/tool-loop pipeline (INV-30 — no tool other than this call itself executes for
 * that session while drafting is active). Two designed exits: an explicit cancel/abort phrase
 * (handled entirely here), and P2's future approval response once a draft is staged for
 * `awaiting_approval` (not yet wired — P2's own phase).
 *
 * The drafting call itself (plan-drafting.ts's draftPlanRevision) is deliberately tool-less: P3
 * is what later lets a from-scratch draft call read_file/list_directory to ground itself in real
 * repo state. Until P3 wires an automatic judgment-based trigger, `enterPlanMode` has no
 * production caller — this whole path is inert by construction (same rollout discipline Q1 used
 * for the ask-question mechanism) and reachable today only via PersonalAssistant.enterPlanMode,
 * an explicit entry point for tests and for P3 to call into once it lands.
 */
export class PlanDraftingService {
  constructor(
    private readonly planService: PlanService,
    private readonly session: AssistantSession,
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
  ) {}

  async draftTurn(sessionId: string, transcriptKey: string, userMessage: string, onUsage: (usage: TokenUsage) => void): Promise<AssistantTurnResult> {
    if (isCancelPlanningPhrase(userMessage)) {
      return this.cancelDrafting(sessionId, transcriptKey, userMessage)
    }

    const existing = await this.planService.loadPlanRecord(sessionId)
    const draft: PlanRecord = existing && existing.mode === 'drafting' ? existing : this.planService.createDraftPlanRecord(null)

    const revision = await draftPlanRevision(
      this.llmClient,
      userMessage,
      draft.tasks,
      draft.successCriteria,
      draft.rationale,
      this.model(),
      onUsage,
    )

    if (!revision) {
      const reply = "I couldn't update the plan draft from that — could you rephrase, or say \"cancel plan\" to stop drafting?"
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
      return { status: 'ok', reply, riskLevel: 'LOW', harnessSkipped: true }
    }

    const tasks: PlanTaskRecord[] = revision.tasks.map((t) => ({ id: t.id, description: t.description, depends_on: t.depends_on, status: 'PENDING', riskLevel: t.riskLevel }))
    const updated: PlanRecord = {
      ...draft,
      tasks,
      successCriteria: revision.successCriteria,
      rationale: revision.rationale,
      updatedAt: new Date().toISOString(),
    }
    await this.planService.savePlan(sessionId, updated)

    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: revision.reply })
    this.onTrace?.({ kind: 'plan_updated', templateName: updated.templateName, completionPct: 0 })

    return {
      status: 'ok',
      reply: revision.reply,
      riskLevel: 'LOW',
      harnessSkipped: true,
      planStatus: {
        templateName: updated.templateName,
        successCriteria: updated.successCriteria,
        completionPct: 0,
        tasks: updated.tasks.map((t) => ({ id: t.id, description: t.description, status: t.status })),
      },
    }
  }

  private async cancelDrafting(sessionId: string, transcriptKey: string, userMessage: string): Promise<AssistantTurnResult> {
    const existing = await this.planService.loadPlanRecord(sessionId)
    if (existing && existing.mode === 'drafting') {
      await this.planService.abandonPlan(sessionId, existing)
    }
    await this.session.exitPlanMode(sessionId)
    const reply = 'Stopped drafting — the plan was discarded. Nothing was run.'
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
    return { status: 'ok', reply, riskLevel: 'LOW', harnessSkipped: true }
  }
}
