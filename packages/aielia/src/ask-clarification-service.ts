import { EscalationHalt, validateAskResponse, type AskQuestion, type AskResponse, type CallerUpdate, type UpdateChannel } from '@buildaharness/harness'
import type { MemoryAdapter } from '@buildaharness/runtime'
import type { AssistantSession } from './assistant-session.js'
import type { HarnessBridge } from './harness-bridge.js'
import type { ResponseService } from './response-service.js'
import type { PlanRecord } from './plan-store.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import type { UserFact } from './fact-extraction.js'
import type { AssistantTurnResult } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'
import { formatAskResponse } from './ask-response-format.js'
import { buildTurnFacts } from './memory-service.js'

/**
 * Everything AskClarificationService.resolvePendingClarification needs to re-drive the harness
 * run once the user answers — persisted alongside the staged questions themselves (mirrors
 * AgentLoop's BatchPendingState, staged the same `memory.set('ask-pending:${id}', ...)` way, see
 * ActionApprovalService's own "resolved by ID, never re-derived from a second LLM call"
 * discipline this mirrors, T4 of the file-tools plan).
 */
export interface AskClarificationPendingState {
  sessionId: string
  questions: AskQuestion[]
  classification: TurnIntentClassification
  activePlan: PlanRecord | null
  facts: UserFact[]
  draftReply: string
}

/**
 * A one-shot UpdateChannel that surfaces the user's AskResponse exactly once, on the first
 * poll() after a harness run resumes — mirrors driveMainLoop's own "inject_clarification" design
 * (checkCallerUpdates polls this every main-loop iteration; see check-caller-updates.ts). Folding
 * the answer into `callerState.updateConstraints()` this way (rather than a bespoke injection
 * path) reuses the existing handleEscalationResponse/applyConstraintChangePropagation machinery
 * the plan calls for, instead of inventing a second one.
 */
class OneShotAnswerChannel implements UpdateChannel {
  private consumed = false
  constructor(private readonly pendingUpdate: Record<string, unknown>) {}
  poll(): CallerUpdate | null {
    if (this.consumed) return null
    this.consumed = true
    return { pending_update: this.pendingUpdate, constraints_changed: true }
  }
}

/**
 * Owns the ask-question "staged clarification, resolved by ID" pattern — Q2 of
 * the internal plan, structurally mirroring ActionApprovalService (T4 of
 * the file-tools plan: what gets resolved is exactly what was staged, never re-derived from a
 * second LLM call). Unlike a write/shell action, resolving a clarification means resuming a
 * *harness run* — the checkpoint HarnessBridge would otherwise have deleted on any thrown
 * EscalationHalt (see HarnessBridge.run()'s askModeEnabled/preserveForClarification handling) is
 * kept alive specifically so this service can hand it back to HarnessBridge with the user's
 * answer folded in via a one-shot UpdateChannel, instead of losing the run's progress and
 * starting over.
 */
export class AskClarificationService {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly session: AssistantSession,
    private readonly harnessBridge: HarnessBridge,
    private readonly responseService: ResponseService,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
  ) {}

  private pendingKey(id: string): string {
    return `ask-pending:${id}`
  }

  /**
   * Stages a batch of questions and returns the `needs_clarification` AssistantTurnResult — the
   * ResponseService.buildEscalatedResult counterpart for a structured-question escalation
   * (called instead of it, from assistant.ts's EscalationHalt catch, when
   * `err.blocker.questions` is populated and the effective askMode is enabled).
   */
  async stageAndRespond(params: {
    sessionId: string
    transcriptKey: string
    userMessage: string
    questions: AskQuestion[]
    classification: TurnIntentClassification
    activePlan: PlanRecord | null
    facts: UserFact[]
    draftReply: string
  }): Promise<AssistantTurnResult> {
    const { sessionId, transcriptKey, userMessage, questions, classification, activePlan, facts, draftReply } = params
    const id = crypto.randomUUID()
    const staged: AskClarificationPendingState = { sessionId, questions, classification, activePlan, facts, draftReply }
    await this.memory.set(this.pendingKey(id), staged)
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    this.onTrace?.({ kind: 'escalation', reason: `needs_clarification: ${questions.map((q) => q.question).join(' | ')}` })
    return {
      status: 'needs_clarification',
      reply: null,
      riskLevel: classification.riskLevel,
      pendingClarificationId: id,
      questions,
    }
  }

  /**
   * Resolves a staged clarification by ID — validates the response against exactly the
   * questions that were staged (INV-28: a malformed/incomplete payload is rejected, never
   * silently coerced), folds the answer into the paused harness run via a one-shot
   * UpdateChannel, and resumes it. A follow-up escalation (INV-37's deferred batch two) routes
   * back through `stageAndRespond` exactly like the first, via the same catch this resume goes
   * through.
   */
  async resolvePendingClarification(
    sessionId: string,
    transcriptKey: string,
    pendingClarificationId: string,
    response: AskResponse | undefined,
    askModeEnabled: boolean,
  ): Promise<AssistantTurnResult> {
    const staged = (await this.memory.get(this.pendingKey(pendingClarificationId))) as AskClarificationPendingState | undefined
    if (!staged) {
      return { status: 'ok', reply: 'That question is no longer pending — nothing to resolve.' }
    }

    // Fail-closed (Protected Invariants): no answer, or an answer that doesn't validate against
    // exactly the staged questions, leaves the turn in needs_clarification rather than silently
    // proceeding or discarding the batch.
    if (!response) {
      return { status: 'needs_clarification', reply: null, reason: 'No answer was provided.', pendingClarificationId, questions: staged.questions, riskLevel: staged.classification.riskLevel }
    }
    try {
      validateAskResponse(staged.questions, response)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { status: 'needs_clarification', reply: null, reason, pendingClarificationId, questions: staged.questions, riskLevel: staged.classification.riskLevel }
    }

    await this.memory.delete(this.pendingKey(pendingClarificationId))
    // Not appended to the transcript here — buildPausedResult/buildSuccessResult/
    // buildEscalatedResult below each already append `userMessage` (here, the rendered answer)
    // as the turn's user message themselves; appending it here too would duplicate it.
    const answerText = formatAskResponse(staged.questions, response)

    const updateChannel = new OneShotAnswerChannel({ clarification_answers: response.answers, ask_questions: staged.questions })
    try {
      const outcome = await this.harnessBridge.run({
        sessionId,
        userMessage: answerText,
        facts: staged.facts,
        // Phase 4 of the internal plan — same
        // reasoning as assistant.ts's own call site: buildSuccessResult below runs recordFacts()
        // with this same (sessionId, answerText, staged.classification.statesDurableFacts) triple,
        // so this stays consistent with what actually gets written to the fact stores this turn.
        currentTurnFacts: buildTurnFacts(sessionId, answerText, staged.classification.statesDurableFacts),
        draftReply: staged.draftReply,
        classification: staged.classification,
        initialTasks: [],
        activePlan: staged.activePlan,
        sources: undefined,
        onUsage: () => {},
        updateChannel,
        askModeEnabled,
      })

      if (outcome.status === 'paused') {
        return this.responseService.buildPausedResult({
          sessionId,
          transcriptKey,
          userMessage: answerText,
          draftReply: staged.draftReply,
          classification: staged.classification,
          activePlan: staged.activePlan,
          checkpoint: outcome.checkpoint,
          lastVerification: outcome.lastVerification,
          layerActivity: outcome.layerActivity,
          sources: undefined,
          batchBudgetTrace: undefined,
          usageTotal: undefined,
        })
      }

      return this.responseService.buildSuccessResult({
        sessionId,
        transcriptKey,
        userMessage: answerText,
        draftReply: staged.draftReply,
        classification: staged.classification,
        activePlan: staged.activePlan,
        result: outcome.result,
        lastVerification: outcome.lastVerification,
        layerActivity: outcome.layerActivity,
        sources: undefined,
        batchBudgetTrace: undefined,
        usageTotal: undefined,
      })
    } catch (err) {
      if (err instanceof EscalationHalt) {
        // INV-37: a deferred follow-up batch (or any other structured-question escalation hit
        // while resuming) restages exactly the same way the first one did.
        if (err.blocker.questions && err.blocker.questions.length > 0 && askModeEnabled) {
          return this.stageAndRespond({
            sessionId,
            transcriptKey,
            userMessage: answerText,
            questions: err.blocker.questions,
            classification: staged.classification,
            activePlan: staged.activePlan,
            facts: staged.facts,
            draftReply: staged.draftReply,
          })
        }
        return this.responseService.buildEscalatedResult({ sessionId, transcriptKey, userMessage: answerText, err, classification: staged.classification })
      }
      throw err
    }
  }
}
