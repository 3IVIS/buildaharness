import {
  riskSummary,
  ControlState,
  type EscalationHalt,
  type HarnessCheckpoint,
  type VerificationResult,
  type LayerActivityEvent,
  type HarnessRunResult,
} from '@buildaharness/harness'
import type { TokenUsage } from '@buildaharness/runtime'
import { buildAnswerClaim } from './answer-claim.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import type { PlanRecord } from './plan-store.js'
import { PlanService } from './plan-service.js'
import type { AssistantSession } from './assistant-session.js'
import type { MemoryService } from './memory-service.js'
import type { AssistantSource } from './assistant-source.js'
import type { BatchBudgetTrace } from './agent-loop.js'
import type { AssistantTrace, AssistantTurnResult } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'

/**
 * AssistantTurnResult assembly for every return path — the triviality fast path, the
 * plan-pacing pause, the harness success path, and the EscalationHalt-caught path — split out of
 * runTurn in Phase 4d of the architecture remediation plan. Each method persists whatever this
 * path needs to persist (transcript, facts, plan) and returns the final result, so the sequencer
 * (assistant.ts) never has to duplicate per-path assembly logic.
 */
export class ResponseService {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly session: AssistantSession,
    private readonly planService: PlanService,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
  ) {}

  async buildTrivialResult(params: {
    sessionId: string
    transcriptKey: string
    userMessage: string
    draftReply: string
    classification: TurnIntentClassification
    sources: AssistantSource[] | undefined
    batchBudgetTrace: BatchBudgetTrace | undefined
    usageTotal: TokenUsage | undefined
  }): Promise<AssistantTurnResult> {
    const { sessionId, transcriptKey, userMessage, draftReply, classification, sources, batchBudgetTrace, usageTotal } = params
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: draftReply })
    await this.memoryService.recordFacts(sessionId, userMessage, classification.statesDurableFact)
    // No layer fired this turn — an empty trace rather than an absent one, so the "Why?"/"Run
    // detail" UI can still render (all 11 layer cells shown, none highlighted) instead of hiding
    // the panel outright, which read as broken rather than "skipped on purpose".
    const skippedTrace: AssistantTrace = { nodeExecutionOrder: [], verificationHealth: { strength: 0, feasibility: 0 }, layerActivity: [], batchBudget: batchBudgetTrace }
    return { status: 'ok', reply: draftReply, riskLevel: classification.riskLevel, stepsUsed: 0, harnessSkipped: true, trace: skippedTrace, sources, usage: usageTotal }
  }

  async buildPausedResult(params: {
    sessionId: string
    transcriptKey: string
    userMessage: string
    draftReply: string
    classification: TurnIntentClassification
    activePlan: PlanRecord | null
    checkpoint: HarnessCheckpoint
    lastVerification: VerificationResult | null
    layerActivity: LayerActivityEvent[]
    sources: AssistantSource[] | undefined
    batchBudgetTrace: BatchBudgetTrace | undefined
    usageTotal: TokenUsage | undefined
  }): Promise<AssistantTurnResult> {
    const { sessionId, transcriptKey, userMessage, draftReply, classification, activePlan, checkpoint, lastVerification, layerActivity, sources, batchBudgetTrace, usageTotal } = params

    // An intentional plan-pacing stop — not a bug. Persist the plan's current task statuses (same
    // as the success path) so the next turn's pacing/position computations start from up-to-date
    // state, and surface a plain "ready to continue?" reply instead of the harness's own
    // draft/final result.
    // R3 of plans/harness_d2_one_loop_rewire_plan.html: under the one-loop flag, `draftReply` is
    // deferred (assistant.ts never precomputes it before calling harnessBridge.run() when a
    // caller-supplied proposer is in play — see agent-loop.ts's createOneLoopProposer) — it stays
    // `''` unless a plan-pacing pause happens to fire after the harness-driven proposer has
    // already produced a real answer for the just-completed task. `checkpoint.progress.finalResult`
    // is exactly that answer: harness-runtime.ts's driveMainLoop sets `ctx.finalResult =
    // execResult.output` right after a task completes, strictly before shouldPause is ever
    // checked, so by the time a pause can fire at all, finalResult already holds that task's real
    // output text. This is also safe (and a no-op) on the flag-OFF path: there,
    // `toolExecutors.default` is always `() => draftReply` for every task, so finalResult always
    // equals draftReply already — reading it here instead changes nothing observable (INV-19),
    // it just also covers the flag-ON case where draftReply alone would otherwise be empty. Same
    // `typeof ... === 'string' ? ... : draftReply` fallback shape buildSuccessResult below already
    // uses for the exact same reason.
    const reportedReply = typeof checkpoint.progress.finalResult === 'string' ? checkpoint.progress.finalResult : draftReply

    let planStatus: AssistantTurnResult['planStatus']
    let reply = 'Paused.'
    let pausedNote: string | undefined
    if (activePlan) {
      const { plan: updatedPlan, planStatus: ps } = await this.planService.saveAndSummarize(sessionId, activePlan, checkpoint.runState.taskGraph.tasks)
      planStatus = ps
      this.onTrace?.({ kind: 'plan_updated', templateName: updatedPlan.templateName, completionPct: ps.completionPct })
      const next = this.planService.nextPendingTask(updatedPlan)
      const pacingNote = next
        ? `Ready to continue with: ${next.description}? (reply to proceed)`
        : 'All plan steps have run — let me know if you want anything else.'
      // draftReply (the LLM's own answer to this turn, computed and streamed to the caller via
      // onToken well before the harness ever ran) must not be dropped here. It was already shown
      // live to a streaming caller (cli.ts's streamedAnyTokens path prints nothing further once
      // tokens have streamed, trusting that whatever gets returned/persisted below matches what's
      // already on screen), so persisting only the pacing note would leave the transcript — and
      // therefore /export, /search, and every later turn's LLM context — recording a reply the
      // user never actually saw, while silently discarding the one they did.
      reply = reportedReply.trim() ? `${reportedReply}\n\n${pacingNote}` : pacingNote
      pausedNote = pacingNote
    }
    const contradictionNotice = await this.session.dedupedContradictionNotice(sessionId, layerActivity)

    const trace: AssistantTrace = {
      nodeExecutionOrder: checkpoint.progress.nodeExecutionOrder,
      verificationHealth: { ...checkpoint.runState.diagnostics.verification_health },
      layerActivity,
      batchBudget: batchBudgetTrace,
    }

    const answerClaim = buildAnswerClaim({
      evidence: checkpoint.runState.evidenceStore.observations,
      verification: lastVerification,
      contradicted: contradictionNotice !== undefined,
      verificationHealth: trace.verificationHealth,
    })

    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
    await this.memoryService.recordFacts(sessionId, userMessage, classification.statesDurableFact)

    return {
      status: 'ok',
      reply,
      riskLevel: classification.riskLevel,
      controlState: {
        riskState: riskSummary(new ControlState(checkpoint.runState.controlState)),
        escalationReason: checkpoint.runState.controlState.escalation_reason,
      },
      stepsUsed: checkpoint.progress.stepsUsed,
      harnessSkipped: false,
      trace,
      sources,
      planStatus,
      contradictionNotice,
      answerClaim,
      pausedNote,
      usage: usageTotal,
    }
  }

  async buildSuccessResult(params: {
    sessionId: string
    transcriptKey: string
    userMessage: string
    draftReply: string
    classification: TurnIntentClassification
    activePlan: PlanRecord | null
    result: HarnessRunResult
    lastVerification: VerificationResult | null
    layerActivity: LayerActivityEvent[]
    sources: AssistantSource[] | undefined
    batchBudgetTrace: BatchBudgetTrace | undefined
    usageTotal: TokenUsage | undefined
  }): Promise<AssistantTurnResult> {
    const { sessionId, transcriptKey, userMessage, draftReply, classification, activePlan, result, lastVerification, layerActivity, sources, batchBudgetTrace, usageTotal } = params

    const stepsUsed = result.stepsUsed
    const controlState = {
      riskState: riskSummary(new ControlState(result.initResult.controlState)),
      escalationReason: result.initResult.controlState.escalation_reason,
    }
    const trace: AssistantTrace = {
      nodeExecutionOrder: result.nodeExecutionOrder,
      verificationHealth: { ...result.initResult.diagnostics.verification_health },
      layerActivity,
      batchBudget: batchBudgetTrace,
    }

    const reply = typeof result.finalResult === 'string' ? result.finalResult : draftReply
    const contradictionNotice = await this.session.dedupedContradictionNotice(sessionId, layerActivity)

    // Write the harness's resulting task statuses back onto the plan only on this success path —
    // an aborted/errored turn leaves the stored plan as-is, so a crash mid-turn can't corrupt
    // plan state; the plan simply gets resumed and re-driven next turn instead.
    let planStatus: AssistantTurnResult['planStatus']
    if (activePlan) {
      const { plan: updatedPlan, planStatus: ps } = await this.planService.saveAndSummarize(sessionId, activePlan, result.initResult.taskGraph.tasks)
      planStatus = ps
      this.onTrace?.({ kind: 'plan_updated', templateName: updatedPlan.templateName, completionPct: ps.completionPct })
    }

    const answerClaim = buildAnswerClaim({
      evidence: result.initResult.evidenceStore.observations,
      verification: lastVerification,
      contradicted: contradictionNotice !== undefined,
      verificationHealth: trace.verificationHealth,
    })

    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
    await this.memoryService.recordFacts(sessionId, userMessage, classification.statesDurableFact)

    return { status: 'ok', reply, riskLevel: classification.riskLevel, controlState, stepsUsed, harnessSkipped: false, trace, sources, planStatus, contradictionNotice, answerClaim, usage: usageTotal }
  }

  async buildEscalatedResult(params: {
    sessionId: string
    transcriptKey: string
    userMessage: string
    err: EscalationHalt
    classification: TurnIntentClassification
  }): Promise<AssistantTurnResult> {
    const { sessionId, transcriptKey, userMessage, err, classification } = params
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    const reason = err.blocker.missing_info.join('; ') || err.blocker.reason
    this.onTrace?.({ kind: 'escalation', reason })
    // stepsUsed is always 0 here: the only place the pre-split code ever assigned a nonzero
    // stepsUsed before this catch ran is the harness success path, which is now fully inside
    // HarnessBridge.run() — this catch is only reachable when EscalationHalt propagated out of
    // that call (or out of code before it), so stepsUsed was never advanced past its initial 0.
    return { status: 'escalated', reply: null, reason, riskLevel: classification.riskLevel, stepsUsed: 0 }
  }
}
