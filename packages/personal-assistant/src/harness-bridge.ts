import {
  HarnessRuntime,
  saveHarnessCheckpoint,
  loadHarnessCheckpoint,
  deleteHarnessCheckpoint,
  type ExperienceStore,
  type Task,
  type CheckpointStore,
  type TurnComplexitySignal,
  type LayerActivityEvent,
  type HarnessCheckpoint,
  type FailureModeEntry,
  type Belief,
  type VerificationResult,
  type HarnessRunResult,
  type ToolExecutorContext,
  type InvestigationRequestData,
  type InvestigationFinding,
} from '@buildaharness/harness'
import type { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime'
import { DEFAULT_ONE_LOOP_MODE, type OneLoopMode } from './one-loop-flag.js'
import { extractFactsFromTurn, tierForFact, isKnowledgeTier, type UserFact } from './fact-extraction.js'
import { checkForContradictions, type BeliefCandidate } from './contradiction-checker.js'
import { checkSemanticReviewConflict } from './review-checker.js'
import { checkSemanticFailureMatch } from './failure-mode-matcher.js'
import { checkSemanticCriterionCoverage, NON_CHECKABLE_DEFAULT_CRITERION } from './semantic-criterion-coverage.js'
import { toTaskRiskLevel } from './task-mapping.js'
import { FACT_CAP } from './memory-service.js'
import { RESUME_ATTEMPT_CAP, resumeAttemptsKey, type AssistantSession } from './assistant-session.js'
import type { PlanRecord } from './plan-store.js'
import type { PlanService } from './plan-service.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import type { AssistantSource } from './assistant-source.js'
import type { AssistantProgress } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'

export type HarnessOutcome =
  | { status: 'paused'; checkpoint: HarnessCheckpoint; lastVerification: VerificationResult | null; layerActivity: LayerActivityEvent[] }
  | { status: 'completed'; result: HarnessRunResult; lastVerification: VerificationResult | null; layerActivity: LayerActivityEvent[] }

export interface HarnessRunParams {
  sessionId: string
  userMessage: string
  facts: UserFact[]
  draftReply: string
  classification: TurnIntentClassification
  initialTasks: Task[]
  activePlan: PlanRecord | null
  sources: AssistantSource[] | undefined
  onProgress?: (progress: AssistantProgress) => void
  onUsage: (usage: TokenUsage) => void
  /**
   * R2 of plans/harness_d2_one_loop_rewire_plan.html: a harness-driven proposer (built by
   * AgentLoop.createHarnessProposer) swapped in as the toolExecutors 'default' entry instead of
   * `() => draftReply`, when the one-loop flag is enabled and a caller actually supplies one.
   * `undefined` (every caller today, before R3 wires runTurn to build one) means `run()` falls
   * back to `() => draftReply` regardless of the flag — R2 only builds the mechanism and proves it
   * against a caller that supplies this directly; wiring runTurn to always supply one when the
   * flag is on is R3's scope.
   */
  oneLoopProposer?: (toolCtx: ToolExecutorContext) => unknown | Promise<unknown>
  /**
   * Trajectory Supervisor GATHER_EVIDENCE host (S5 of
   * plans/harness_trajectory_supervisor_plan.html) — AgentLoop.runSupervisorInvestigation bound
   * to this turn's read-only tools + risk hint. Passed straight through to
   * HarnessRunOptions.runInvestigation. `undefined` (every caller until a supervisorDecider is
   * also wired) → GATHER_EVIDENCE degrades to CONTINUE inside the harness, so this is inert by
   * default exactly like onSupervisorDirective.
   */
  runInvestigation?: (req: InvestigationRequestData) => Promise<InvestigationFinding[]>
}

/**
 * HarnessRuntime construction + invocation: the runOptions assembly, checkpoint load +
 * RESUME_ATTEMPT_CAP logic, runtime.run()/.resume() dispatch, and the paused-vs-completed
 * outcome split — split out of runTurn in Phase 4d of the architecture remediation plan.
 * `EscalationHalt` is deliberately NOT caught here — it propagates out of `run()` so the
 * sequencer's single try/catch still handles it (assistant.ts's runTurn/ResponseService).
 */
export class HarnessBridge {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly experienceStore: ExperienceStore,
    private readonly checkpointStore: CheckpointStore,
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly maxSteps: number,
    private readonly planService: PlanService,
    private readonly assistantSession: AssistantSession,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
    // R2 of plans/harness_d2_one_loop_rewire_plan.html: injected (not read from process.env here)
    // so tests never touch real process.env — see one-loop-flag.ts's doc comment, mirroring
    // control-plane-flag.ts's now-removed injectable-mode convention. Only cli.ts (or an
    // equivalent surface entry point) is expected to call resolveOneLoopMode(process.env) and
    // pass the result down; PersonalAssistant itself never touches process.env directly.
    private readonly oneLoopMode: OneLoopMode = DEFAULT_ONE_LOOP_MODE,
  ) {}

  async run(params: HarnessRunParams): Promise<HarnessOutcome> {
    const { sessionId, userMessage, facts, draftReply, classification, initialTasks, activePlan, sources, onProgress, onUsage, oneLoopProposer, runInvestigation } = params
    const runtime = new HarnessRuntime()
    // One harness run per (session, turn) — a run_id a resumed run can be found under if this
    // turn's process died mid-run before reaching the `finally` cleanup below.
    const runId = `turn:${sessionId}`

    // One shared per-turn signal instead of each harness layer inventing its own gating
    // heuristic. write_file/run_shell_command never reach this point today — a pending approval
    // for either always returns needs_approval/is auto-applied before the harness run starts —
    // so consequentialTools only ever holds the read-only tool kinds actually exercised via
    // `sources`, included for the day a harness-driven mutation path exists.
    const complexitySignal: TurnComplexitySignal = {
      riskLevel: toTaskRiskLevel(classification.riskLevel),
      taskCount: initialTasks.length,
      hasDurablePlan: activePlan !== null,
      consequentialTools: new Set(sources?.map(s => s.tool) ?? []),
    }

    // Pace a durable plan one MEDIUM/HIGH-risk step at a time across turns instead of running
    // its whole unblocked frontier in a single turn — shouldPause below reads
    // riskById/lastStatusById to decide when to stop. A LOW-risk step never sets a pause point,
    // so an all-LOW-risk plan still batches straight through. null for an ad hoc
    // single-task/decomposed turn — those resolve within one turn by design.
    const planPacing = activePlan
      ? {
          riskById: new Map(initialTasks.map((t) => [t.id, t.risk_level] as const)),
          lastStatusById: new Map(initialTasks.map((t) => [t.id, t.status] as const)),
        }
      : null

    // Every layer's fired/skipped report this turn, structured so AssistantTrace.layerActivity
    // is populated the same "absent caller, still works" way nodeExecutionOrder/
    // verificationHealth already are.
    const layerActivityThisTurn: LayerActivityEvent[] = []
    // The last real VerificationResult this turn produced (a multi-task turn can call verify()
    // more than once; the last one reflects the final task's outcome) — feeds buildAnswerClaim
    // (ResponseService). null if verify() never ran at all this turn.
    let lastVerification: VerificationResult | null = null

    let pausedThisTurn = false

    // The harness's WorldModel is scratch state, rebuilt empty every turn — without this, a
    // fact stated in an earlier turn is gone by the time a later turn's message might
    // contradict it, so Contradiction (and World Model's own belief trail) never has more
    // than one turn's own facts to work with, no matter how long the conversation runs. Seeded
    // once per turn (not once per task, unlike the current-turn extraction below) — every task
    // in a multi-task turn re-deriving the same prior beliefs would just duplicate them.
    let priorFactsSeeded = false
    const factExtractor = (objective: string): Array<{ statement: string; isNew?: boolean }> => {
      // isNew:true marks a fact this turn's message actually stated — see harness-runtime.ts's
      // world_model layer_activity report, which only surfaces one of these as "Remembered:
      // ...". Prior facts are re-seeded so the contradiction checker has something to compare
      // against, but they're not new this turn and shouldn't be reported as if they were.
      const currentTurnFacts = extractFactsFromTurn(objective, runId).map(f => ({ statement: f.text, isNew: true }))
      if (priorFactsSeeded) return currentTurnFacts
      priorFactsSeeded = true
      // Phase E / criticism001 #8: contradiction detection reads the Knowledge tier only — a
      // model_inferred musing recorded on some earlier turn (classifyTurnIntent's unconfirmed
      // statesDurableFact guess, see fact-extraction.ts's recordFacts doc comment) must not
      // re-enter the belief pool on a later turn and get treated as an established fact to
      // contradict against. Every fact this file's own extractFactsFromTurn call below produces
      // is already user_asserted, so this filter is a no-op for currentTurnFacts and only ever
      // narrows the re-seeded prior set.
      const priorFacts = facts.filter(f => isKnowledgeTier(tierForFact(f))).slice(-FACT_CAP).map(f => ({ statement: f.text }))
      return [...priorFacts, ...currentTurnFacts]
    }

    try {
      const runOptions = {
        initialTasks,
        // Every task in a decomposed graph executes against the same single draftReply —
        // PersonalAssistant still makes only one real content-generating LLM call per turn
        // (plus decomposeObjective's own call, when it ran). Decomposition changes the harness's
        // task-graph *shape* (visible in stepsUsed/nodeExecutionOrder), not the number of
        // distinct replies produced.
        //
        // R2 of plans/harness_d2_one_loop_rewire_plan.html: flag-OFF (the default) and flag-ON
        // with no caller-supplied proposer are byte-identical to the line above — `() =>
        // draftReply` — satisfying INV-19. Flag-ON with a real oneLoopProposer swaps it in as the
        // 'default' toolExecutor instead, read once per turn right here.
        toolExecutors: { default: this.oneLoopMode === 'enabled' && oneLoopProposer ? oneLoopProposer : () => draftReply },
        experienceStore: this.experienceStore,
        // One harness main-loop iteration attempts at most one task, so a flat maxSteps could
        // never let a decomposed/plan-driven task graph even be *attempted* in full once tasks
        // genuinely reach COMPLETE — this only ever raises the budget for a turn with more
        // tasks than the configured default, never lowers it.
        max_steps: Math.max(this.maxSteps, initialTasks.length),
        runId,
        // Reuses the same extraction pass recordFacts() already runs post-turn — this feeds the
        // harness's world model with real INFERENCE beliefs in addition to (not instead of) the
        // separate `facts:${sessionId}` store recordFacts() writes to. Also seeds beliefs from
        // every already-known fact, once per turn — see factExtractor above.
        factExtractor,
        complexitySignal,
        // Forward every layer's fired/skipped report onto the same onTrace channel
        // harness_node/tool_call events already use — no new transport, just a new TraceEvent
        // kind a "Why?" panel can key off of — and also collect it into
        // AssistantTrace.layerActivity for a caller that never wires onTrace.
        onLayerActivity: (event: LayerActivityEvent) => {
          layerActivityThisTurn.push(event)
          this.onTrace?.({ kind: 'layer_activity', layer: event.layer, fired: event.fired, reason: event.reason })
        },
        onVerification: (result: VerificationResult) => {
          lastVerification = result
        },
        // Trajectory Supervisor GATHER_EVIDENCE host (S5). Inert unless a supervisorDecider is
        // also wired and returns a GATHER_EVIDENCE directive at a stall edge; absent → the
        // harness degrades GATHER_EVIDENCE to CONTINUE.
        runInvestigation,
        // Layered on top of the harness's own always-on lexical/negation-pair check — one call
        // per belief-set growth (never per-pair, never a full re-scan), and skipped entirely
        // when every newly-added belief looks like a structured/technical claim the lexical
        // check already covers. Filtered against AssistantSession's notifiedContradictions so an
        // unresolved conflict already surfaced once this session doesn't get independently
        // rediscovered and re-notified by every later turn's fresh, from-scratch WorldModel.
        contradictionChecker: async (newBeliefs: BeliefCandidate[], existingBeliefs: BeliefCandidate[]) => {
          const results = await checkForContradictions(newBeliefs, existingBeliefs, this.llmClient, this.model(), onUsage)
          const statementById = new Map([...newBeliefs, ...existingBeliefs].map((b) => [b.id, b.statement]))
          const seen = await this.assistantSession.getNotifiedContradictions(sessionId)
          const filtered: typeof results = []
          for (const c of results) {
            const signature = [...c.beliefIds].map((id) => statementById.get(id) ?? id).sort().join(' ')
            if (seen.has(signature)) continue
            await this.assistantSession.recordNotifiedContradiction(sessionId, seen, signature)
            filtered.push(c)
          }
          return filtered
        },
        // Layered on top of review-proposed-change.ts's lexical isNegation check — same "skip
        // when it reads like a coding fact" gate contradictionChecker uses, since that's the
        // domain the fixed-phrase check already covers reasonably well.
        semanticChangeReviewer: (input: { changeDescription: string; highConfidenceBeliefs: BeliefCandidate[]; hypothesisPredictions: string[] }) =>
          checkSemanticReviewConflict(input.changeDescription, input.highConfidenceBeliefs, input.hypothesisPredictions, this.llmClient, this.model(), onUsage),
        // Layered on top of FailureModeLibrary's own exact-string-overlap match() — see
        // failure-mode-matcher.ts's doc comment for why exact equality against a curated symptom
        // list almost never happens for free-text observations in practice.
        semanticFailureMatcher: (symptoms: string[], libraryEntries: readonly FailureModeEntry[]) =>
          checkSemanticFailureMatch(symptoms, libraryEntries, this.llmClient, this.model(), onUsage),
        // Layered on top of reviewerPass's implementerLens's own `.includes()` substring check —
        // called only for a success criterion that substring check found no coverage for. See
        // semantic-criterion-coverage.ts's doc comment.
        semanticCriterionCoverage: (criterion: string, beliefs: Belief[]) =>
          checkSemanticCriterionCoverage(criterion, beliefs, this.llmClient, this.model(), onUsage),
        // Stop right after a MEDIUM/HIGH-risk plan step resolves (COMPLETE or FAILED), before
        // the loop would go pick the next one — undefined for a non-plan turn, so shouldPause is
        // simply never checked and behavior is unchanged.
        shouldPause: planPacing
          ? (cp: HarnessCheckpoint) => {
              if (cp.progress.nodeExecutionOrder.at(-1) !== 'update_task_state') return false
              let pause = false
              for (const t of cp.runState.taskGraph.tasks) {
                const prevStatus = planPacing.lastStatusById.get(t.id)
                if (prevStatus !== t.status && (t.status === 'COMPLETE' || t.status === 'FAILED')) {
                  const risk = planPacing.riskById.get(t.id)
                  if (risk === 'MEDIUM' || risk === 'HIGH') pause = true
                }
                planPacing.lastStatusById.set(t.id, t.status)
              }
              return pause
            }
          : undefined,
        onCheckpoint: (checkpoint: Parameters<typeof saveHarnessCheckpoint>[1]) => {
          // Live, mid-run plan position — computed from the same live task-graph snapshot
          // updatePlanFromRun uses post-turn, just run once per checkpoint instead of once at
          // the very end, so a caller sees "step 3/7" while the run is still going.
          const planPosition = activePlan ? this.planService.computePlanPosition(activePlan, checkpoint.runState.taskGraph.tasks) ?? undefined : undefined
          onProgress?.({
            stepsUsed: checkpoint.progress.stepsUsed,
            maxSteps: this.maxSteps,
            currentNode: checkpoint.progress.nodeExecutionOrder.at(-1),
            planPosition,
          })
          const node = checkpoint.progress.nodeExecutionOrder.at(-1)
          if (node) this.onTrace?.({ kind: 'harness_node', node, stepsUsed: checkpoint.progress.stepsUsed })
          return saveHarnessCheckpoint(this.checkpointStore, checkpoint)
        },
      }

      let priorCheckpoint = await loadHarnessCheckpoint(this.checkpointStore, runId)
      if (priorCheckpoint) {
        const priorAttempts = ((await this.memory.get(resumeAttemptsKey(sessionId))) as number | undefined) ?? 0
        if (priorAttempts >= RESUME_ATTEMPT_CAP) {
          // See RESUME_ATTEMPT_CAP's doc comment: this checkpoint has already failed to resume
          // (via a process crash that never reached this method's own finally cleanup below — an
          // ordinary in-process failure is cleaned up there on its first attempt already) enough
          // times in a row that retrying again would just wedge the session permanently. Discard
          // it and start this turn fresh instead, the same recovery clearCheckpoint() offers
          // manually.
          await deleteHarnessCheckpoint(this.checkpointStore, runId)
          await this.memory.delete(resumeAttemptsKey(sessionId))
          this.onTrace?.({ kind: 'checkpoint_discarded', sessionId, failedAttempts: priorAttempts })
          priorCheckpoint = undefined
        } else {
          // Persisted BEFORE the resume() call, not after — see RESUME_ATTEMPT_CAP's doc comment
          // for why this specific ordering is what makes the cap reachable at all.
          await this.memory.set(resumeAttemptsKey(sessionId), priorAttempts + 1)
        }
      }
      const outcome = priorCheckpoint
        ? await runtime.resume(priorCheckpoint, runOptions)
        : await runtime.run(
            userMessage,
            [NON_CHECKABLE_DEFAULT_CRITERION],
            runOptions,
          )
      // resume() (if that's the path taken above) returned normally — paused or completed,
      // either way not a failure — so this checkpoint isn't the problem; don't let a stale count
      // from a since-resolved issue prematurely trip the cap on some future unrelated failure.
      if (priorCheckpoint) await this.memory.delete(resumeAttemptsKey(sessionId))

      if (outcome.status === 'paused') {
        // An intentional plan-pacing stop — not a bug. Keep the checkpoint (resume() picks it up
        // via the priorCheckpoint branch above on the next turn() call).
        pausedThisTurn = true
        return { status: 'paused', checkpoint: outcome.checkpoint, lastVerification, layerActivity: layerActivityThisTurn }
      }

      return { status: 'completed', result: outcome.result, lastVerification, layerActivity: layerActivityThisTurn }
    } finally {
      // A completed or genuinely-escalated (terminal halt) turn has nothing left to resume, so
      // drop the checkpoint — but an intentional plan-pacing pause must keep it, so the next
      // turn() call's priorCheckpoint branch resumes this same run instead of starting a fresh
      // one. EscalationHalt thrown out of runtime.run()/resume() above propagates straight
      // through this finally (pausedThisTurn stays false, so its checkpoint is still cleaned up
      // here) to the sequencer's own try/catch.
      if (!pausedThisTurn) {
        await deleteHarnessCheckpoint(this.checkpointStore, runId).catch(() => {})
        // Keeps the two in sync — an in-process failure (unlike the process-crash case
        // RESUME_ATTEMPT_CAP exists for) is cleaned up right here on its first attempt, so a
        // stale count must not linger to prematurely trip the cap on some later, unrelated
        // checkpoint for this same session.
        await this.memory.delete(resumeAttemptsKey(sessionId)).catch(() => {})
      }
    }
  }
}
