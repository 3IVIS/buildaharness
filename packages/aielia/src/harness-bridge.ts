import {
  HarnessRuntime,
  saveHarnessCheckpoint,
  loadHarnessCheckpoint,
  deleteHarnessCheckpoint,
  EscalationHalt,
  type ExperienceStore,
  type Task,
  type CheckpointStore,
  type TurnSignals,
  deriveConsequentialTools,
  computeRunState,
  type LayerActivityEvent,
  type HarnessCheckpoint,
  type FailureModeEntry,
  type Belief,
  type VerificationResult,
  type HarnessRunResult,
  type ToolExecutorContext,
  type InvestigationRequestData,
  type InvestigationFinding,
  type TrajectoryDigestData,
  type SupervisorDirective,
  type UserQuestionData,
  type UpdateChannel,
  Budget,
  LAYER_CALL_COST,
  buildLayerOutcomeRow,
  buildShadowRow,
  buildFeedbackRow,
} from '@buildaharness/harness'
import { decideSupervisorDirective } from './supervisor-decider.js'
import type { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime'
import { DEFAULT_ONE_LOOP_MODE, type OneLoopMode } from './one-loop-flag.js'
import { tierForFact, isKnowledgeTier, factReliability, type UserFact } from './fact-extraction.js'
import { checkForContradictions, type BeliefCandidate } from './contradiction-checker.js'
import { syncHarnessLexicalEnv } from './lexical/lexical-mode.js'
import { checkSemanticReviewConflict } from './review-checker.js'
import { checkSemanticFailureMatch } from './failure-mode-matcher.js'
import { checkSemanticCriterionCoverage, NON_CHECKABLE_DEFAULT_CRITERION } from './semantic-criterion-coverage.js'
import { checkTaskCompletion, semanticTaskCompletionEnabled } from './task-completion-check.js'
import { checkConstraints, mergeStandingConstraints, semanticConstraintCheckEnabled } from './constraint-check.js'
import { toTaskRiskLevel } from './task-mapping.js'
import { TOOL_EFFECT_CLASS } from './tool-effect-class.js'
import { FACT_CAP } from './memory-service.js'
import { RESUME_ATTEMPT_CAP, resumeAttemptsKey, type AssistantSession } from './assistant-session.js'
import type { PlanRecord } from './plan-store.js'
import type { PlanService } from './plan-service.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import type { AssistantSource } from './assistant-source.js'
import type { AssistantProgress } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'
import { resolveSupervisorEnabled } from './supervisor-flag.js'
import { controlStateGateEnabled } from './tool-control-plane.js'
import { reviewerRevisionEnabled, reviewerRevisionNote, isCheckableCriterion } from './reviewer-revision.js'
import { harnessTokenBudgetTotal } from './harness-token-budget.js'
import { semanticHypothesesEnabled, proposeCompetingExplanations, judgeHypothesesAgainstEvidence } from './semantic-hypotheses.js'
import type { SemanticHypothesisEvent, SemanticHypothesisProposal } from '@buildaharness/harness'
import { recordLayerTelemetry } from './layer-telemetry.js'
import { resolveEscalationPlan, escalationEnabled, escalationHookWired, optInLayerEnabled, harnessGatePolicy, turnPolicyBudget, type EscalationPlan } from './layer-policy-wiring.js'
import type { LayerDecision, LayerPolicyMode } from '@buildaharness/harness'

/**
 * `AUDIT_VERIFICATION` gate — feature-value audit (Phase C5 of the internal plan). EVAL-ONLY:
 * default **ON** (an unset / empty / truthy value keeps today's always-on verification). Only the
 * benchmark's `verificationOff` arm sets a falsy value (`0` / `false` / `off` / `no` / `disabled`),
 * which makes `HarnessBridge.run` pass `skipVerification: true` to HarnessRuntime. Read at exactly
 * one call site (below); no product path sets it. Same shape as `semanticContradictionEnabled()`.
 */
export function verificationEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_VERIFICATION ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * `AUDIT_EXPERIENCE_LEARNING` gate. Default **OFF**: the harness never writes its journal or updates the experience store, so
 * `warmStart` / the recovery ladder keep reading an empty store, exactly as before. A truthy value (`1` / `true` / `on` / `yes` /
 * `enabled`) makes HarnessBridge.run pass `experienceLearning: true` — see packages/harness/src/experience-learning.ts. It changes
 * how a LATER run orders its recovery strategies, so it ships off until a benchmark shows it helps. Read at one site (below).
 */
export function experienceLearningEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_EXPERIENCE_LEARNING ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

/**
 * `AUDIT_RETRY_FAILED_TASK` gate. Default **OFF**. On (`1`/`true`/`on`/`yes`/`enabled`) makes HarnessBridge.run pass
 * `retryFailedTask: true`: after the recovery ladder switches strategy for a failed task, the failed task is re-queued so the
 * new strategy actually gets an attempt (HarnessRunOptions.retryFailedTask). Off, a failed single task — or a multi-task turn
 * whose tasks fail together — ends with nothing to run and the turn answers "could not complete". Read fresh each run.
 */
export function retryFailedTaskEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_RETRY_FAILED_TASK ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

/**
 * `AUDIT_RETRY_SYSTEM_ERRORS` gate. Default **ON** (`0`/`false`/`off`/`no`/`disabled` restores the old behaviour). Makes
 * HarnessBridge.run pass `retryFailedSystemErrors: true`: after the recovery ladder switches strategy for a task whose failure
 * was a SYSTEM error (the model or a tool call threw), the task is re-queued so the new strategy gets an attempt, instead of
 * the turn giving up with "I couldn't complete this" after one transient error. An exhausted tool-loop budget, a rejected
 * completion check and a failed verification are NOT retried (the wider `AUDIT_RETRY_FAILED_TASK` retries those too and stays
 * off). Bounded by the ladder's MAX_SWITCHES and the stall rule. Read fresh each run.
 */
export function retrySystemErrorsEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_RETRY_SYSTEM_ERRORS ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * `AUDIT_REVIEWER_PASS` gate — feature-value audit (Phase C6 of the internal plan). EVAL-ONLY:
 * default **ON** (an unset / empty / truthy value keeps today's always-on 3-lens reviewer pass).
 * Only the benchmark's `reviewerPassOff` arm sets a falsy value (`0` / `false` / `off` / `no` /
 * `disabled`), which makes `HarnessBridge.run` pass `skipReviewerPass: true` to HarnessRuntime.
 * Read at exactly one call site (below); no product path sets it. Same shape as
 * `verificationEnabled()`.
 */
export function reviewerPassEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_REVIEWER_PASS ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * P4 of the internal plan (Open Decisions #2, recommended default: yes):
 * once an approved plan's `executingOnPlan` removes the per-MEDIUM/HIGH-risk pacing pause below,
 * auto-advance could otherwise chain arbitrarily many tasks' worth of LLM calls into one turn. This
 * is a distinct, always-on ceiling — a hard stop on task count regardless of risk level, mirroring
 * agent-loop.ts's BATCH_ABSOLUTE_TURN_CEILING/Budget shape — not a replacement for the risk-based
 * check it sits alongside; the risk check is what's removed for an executing plan, this isn't.
 */
const PLAN_AUTO_ADVANCE_TASK_CEILING = 10

export type HarnessOutcome =
  | { status: 'paused'; checkpoint: HarnessCheckpoint; lastVerification: VerificationResult | null; layerActivity: LayerActivityEvent[]; taskNotes: Record<string, string> }
  | { status: 'completed'; result: HarnessRunResult; lastVerification: VerificationResult | null; layerActivity: LayerActivityEvent[]; taskNotes: Record<string, string> }

export interface HarnessRunParams {
  sessionId: string
  userMessage: string
  facts: UserFact[]
  /**
   * Phase 4 of the internal plan: this turn's
   * merged lexical+LLM fact list — memory-service.ts's `buildTurnFacts()`, the exact helper
   * `recordFacts()` itself uses to decide what to write to the fact stores — fed into
   * `factExtractor` below as this turn's "isNew" belief seed. Replaces this file's former direct
   * `extractFactsFromTurn(objective, runId)` call, which only ever saw the free lexical pass and
   * left a same-turn LLM-caught fact invisible to contradiction detection until (if ever) a later
   * turn's re-seed. Defaults to `[]` when omitted, matching pre-Phase-4 behavior for a caller that
   * doesn't supply it.
   */
  currentTurnFacts?: UserFact[]
  draftReply: string
  classification: TurnIntentClassification
  initialTasks: Task[]
  activePlan: PlanRecord | null
  sources: AssistantSource[] | undefined
  onProgress?: (progress: AssistantProgress) => void
  onUsage: (usage: TokenUsage) => void
  /**
   * R2 of the internal plan: a harness-driven proposer (built by
   * AgentLoop.createHarnessProposer) swapped in as the toolExecutors 'default' entry instead of
   * `() => draftReply`, when the one-loop flag is enabled and a caller actually supplies one.
   * `undefined` (every caller today, before R3 wires runTurn to build one) means `run()` falls
   * back to `() => draftReply` regardless of the flag — R2 only builds the mechanism and proves it
   * against a caller that supplies this directly; wiring runTurn to always supply one when the
   * flag is on is R3's scope.
   */
  oneLoopProposer?: (toolCtx: ToolExecutorContext) => unknown | Promise<unknown>
  /** Semantic change reviewer found a conflict — advisory (see HarnessRunOptions.onReviewConflict). The caller decides how to surface it. */
  onReviewConflict?: (event: { taskId: string; reason: string }) => void
  /** Competing explanations were generated for an underdetermined request, or one was eliminated by evidence (AUDIT_SEMANTIC_HYPOTHESES). The caller decides how to surface it. */
  onSemanticHypothesis?: (event: SemanticHypothesisEvent) => void
  /** The competing explanations were already asked for (a tool-less turn drafts its reply first): the harness registers this answer instead of making a second call. `null` = asked, none. `undefined` = not asked. */
  precomputedHypotheses?: SemanticHypothesisProposal[] | null
  /** The opt-in layers' plan for this turn (adaptive mode only); see resolveOptInPlan. Absent: each layer's own flag decides. */
  optInPlan?: EscalationPlan
  /** The reviewer pass's verdict sent the last answer back for one revision (AUDIT_REVIEWER_REVISION): the note to put in front of the proposer. */
  onReviewerRevision?: (event: { taskId: string; note: string }) => void
  /** A constraint the user stated this turn was violated by the finished answer: the note to hand the proposer for its one second answer. */
  onConstraintRevision?: (event: { taskId: string; note: string }) => void
  /** Tokens this turn's model calls have used so far (input + output) — what AUDIT_HARNESS_TOKEN_BUDGET reports to the harness. */
  tokensUsed?: () => number
  /** A confident failure-mode match picked the recovery strategy — advisory (see HarnessRunOptions.onFailureModeSwitch). The caller decides how to surface it. */
  onFailureModeSwitch?: (event: { taskId: string; failure_class: string; strategy: string }) => void
  /** With AUDIT_EXPERIENCE_LEARNING on, a ranking learned from earlier runs picked the recovery strategy — advisory (see HarnessRunOptions.onLearnedStrategySwitch). */
  onLearnedStrategySwitch?: (event: { taskId: string; failure_class: string; strategy: string }) => void
  /**
   * Trajectory Supervisor GATHER_EVIDENCE host (S5 of
   * the internal plan) — AgentLoop.runSupervisorInvestigation bound
   * to this turn's read-only tools + risk hint. Passed straight through to
   * HarnessRunOptions.runInvestigation. `undefined` (every caller until a supervisorDecider is
   * also wired) → GATHER_EVIDENCE degrades to CONTINUE inside the harness, so this is inert by
   * default exactly like onSupervisorDirective.
   */
  runInvestigation?: (req: InvestigationRequestData) => Promise<InvestigationFinding[]>
  /**
   * Q2 of the internal plan — the already-resolved effective askMode
   * (Q1's three-tier INV-29 resolution), threaded straight into HarnessRunOptions.askMode so the
   * harness's own supervisor ASK_USER path (S3) batches questions consistently with
   * AskClarificationService's own gating. Also decides whether a thrown EscalationHalt carrying
   * a populated `blocker.questions` gets to keep its checkpoint alive (see the `finally` block
   * below) instead of being deleted as a terminal escalation. Defaults to false — byte-identical
   * to pre-Q2 behavior when omitted.
   */
  askModeEnabled?: boolean
  /**
   * Q2 — AskClarificationService.resolvePendingClarification's one-shot channel carrying the
   * user's AskResponse back into the paused run's `callerState` via the harness's own
   * checkCallerUpdates/applyConstraintChangePropagation path (nodes/check-caller-updates.ts).
   * Passed straight through to HarnessRunOptions.updateChannel; undefined (every caller before
   * Q2) defaults to a no-op channel inside the harness, unchanged.
   */
  updateChannel?: UpdateChannel
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
    // R2 of the internal plan: injected (not read from process.env here)
    // so tests never touch real process.env — see one-loop-flag.ts's doc comment, mirroring
    // control-plane-flag.ts's now-removed injectable-mode convention. Only cli.ts (or an
    // equivalent surface entry point) is expected to call resolveOneLoopMode(process.env) and
    // pass the result down; PersonalAssistant itself never touches process.env directly.
    private readonly oneLoopMode: OneLoopMode = DEFAULT_ONE_LOOP_MODE,
    // AL8a: static (default) executes today's behaviour byte-for-byte; shadow does too but records
    // what adaptive would decide; adaptive executes the resolved policy. See layer-policy-wiring.ts.
    private readonly layerPolicyMode: LayerPolicyMode = 'static',
  ) {}

  /** AL9b: runId of the previous turn's outcome row, so this turn's `pushbackOnPriorTurn` can be recorded against it. */
  private lastOutcomeRunId: string | undefined
  private outcomeSeq = 0

  /** AL9b: persist the per-layer outcome row (and, under shadow, the shadow-vs-executed row). Never throws, never affects the turn. */
  private recordTurnTelemetry(
    runId: string,
    plan: EscalationPlan,
    activity: readonly LayerActivityEvent[],
    verification: VerificationResult | null,
    completed: boolean,
    measured?: { layerUse: Record<string, { calls: number; tokens: number }>; shadowFailureDecision?: LayerDecision },
  ): void {
    try {
      const verificationFailed = verification?.has_critical_failure === true
      // runId is per-session (the checkpoint key), so it repeats every turn — make the row id unique per turn.
      const turnId = `${runId}:${Date.now().toString(36)}${(this.outcomeSeq++).toString(36)}`
      const row = buildLayerOutcomeRow({
        runId: turnId,
        mode: plan.mode,
        tier: plan.tier,
        activity,
        // `fired` on these layers means a finding was produced (see harness-runtime's reportLayer reasons).
        changedLayers: ['contradiction', 'reviewer_pass', 'recovery', ...(verificationFailed ? ['verification'] : [])],
        completed,
        ...(measured ? { layerUse: measured.layerUse } : {}),
      })
      if (row === undefined) return
      recordLayerTelemetry(this.experienceStore, row, `layer_outcome:${turnId}`)
      this.lastOutcomeRunId = turnId
      if (plan.shadow !== undefined) {
        const observedByLayer = Object.fromEntries(Object.entries(measured?.layerUse ?? {}).map(([k, v]) => [k, v.calls]))
        const observedCalls = Object.values(observedByLayer).reduce((n, c) => n + c, 0)
        const shadowPolicy = measured?.shadowFailureDecision ? { ...plan.shadow.policy, failure_match: measured.shadowFailureDecision } : plan.shadow.policy
        recordLayerTelemetry(this.experienceStore, buildShadowRow({
          runId: turnId,
          executed: plan.policy,
          executedTier: plan.tier,
          shadow: { policy: shadowPolicy, tier: plan.shadow.tier },
          layerCosts: LAYER_CALL_COST,
          observedCalls,
          observedByLayer,
          verificationFailed,
        }), `shadow_turn:${turnId}`)
      }
    } catch {
      // telemetry is observational only
    }
  }

  /**
   * Drops the paused harness run a `needs_clarification` left behind (its checkpoint and its resume-attempt counter),
   * so the next ordinary run for this session starts fresh instead of resuming it. Used when a clarification answer
   * is handed to the ordinary turn pipeline rather than fed back into the paused run.
   */
  async discardPausedRun(sessionId: string): Promise<void> {
    await deleteHarnessCheckpoint(this.checkpointStore, `turn:${sessionId}`).catch(() => {})
    await this.memory.delete(resumeAttemptsKey(sessionId)).catch(() => {})
  }

  async run(params: HarnessRunParams): Promise<HarnessOutcome> {
    const { sessionId, userMessage, facts, currentTurnFacts = [], draftReply, classification, initialTasks, activePlan, sources, onProgress, onUsage, oneLoopProposer, runInvestigation, askModeEnabled = false, updateChannel, onReviewConflict, onFailureModeSwitch, onLearnedStrategySwitch, onSemanticHypothesis, precomputedHypotheses, optInPlan, onReviewerRevision, onConstraintRevision, tokensUsed } = params
    // Measured LLM use of the instrumented escalation hooks this turn (telemetry only): each hook's usage callback also lands here.
    const layerUse: Record<string, { calls: number; tokens: number }> = {}
    const usageFor = (layer: string) => (usage: TokenUsage): void => {
      onUsage(usage)
      const e = (layerUse[layer] ??= { calls: 0, tokens: 0 })
      e.calls++
      e.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    }
    const runtime = new HarnessRuntime()
    // One harness run per (session, turn) — a run_id a resumed run can be found under if this
    // turn's process died mid-run before reaching the `finally` cleanup below.
    const runId = `turn:${sessionId}`
    // Constraints stated earlier this session plus this turn's. Only where the semantic judge replaces the lexical match
    // (`=0` must not start failing turns on a word match) and there is a proposer to re-ask.
    const standingConstraints = semanticConstraintCheckEnabled() && oneLoopProposer
      ? mergeStandingConstraints(await this.assistantSession.getStandingConstraints(sessionId), classification.statedConstraints ?? [])
      : []

    // One shared per-turn signal instead of each harness layer inventing its own gating
    // heuristic. AL5a: `consequentialTools` is derived from each tool's effect class (write /
    // execute — see TOOL_EFFECT_CLASS), not from `sources`, which only ever held the read-only
    // tools actually exercised (write_file/run_shell_command never reach a harness run — a pending
    // approval always returns needs_approval/is auto-applied first) and so made "consequential" a
    // misnomer. What was exercised still drives the evidence-escalation gate, via `exercisedTools`.
    const complexitySignal: TurnSignals = {
      riskLevel: toTaskRiskLevel(classification.riskLevel),
      taskCount: initialTasks.length,
      hasDurablePlan: activePlan !== null,
      consequentialTools: deriveConsequentialTools(Object.keys(TOOL_EFFECT_CLASS), TOOL_EFFECT_CLASS),
      exercisedTools: new Set(sources?.map(s => s.tool) ?? []),
      needsGrounding: classification.needsGrounding,
      ambiguity: classification.ambiguity,
      userPosture: classification.userPosture,
      pushbackOnPriorTurn: classification.pushbackOnPriorTurn,
      statesConstraint: classification.statesConstraint,
      runState: computeRunState({
        outcomes: initialTasks.filter(t => t.status === 'COMPLETE' || t.status === 'FAILED').map(t => t.status === 'FAILED'),
        untrustedContentInContext: (sources?.length ?? 0) > 0,
      }),
    }

    // AL8a: one policy per turn; the semantic escalation hooks below are gated through it.
    const escalationSignals = { ...complexitySignal, isTrivial: classification.isTrivial }
    const escalationPlan = resolveEscalationPlan(this.layerPolicyMode, escalationSignals, complexitySignal.runState, undefined, turnPolicyBudget(escalationSignals))
    // The failure-mode matcher is asked only about a task that has FAILED, so the question "does this layer run?" is always
    // asked with at least one failure behind it. Judged from the turn's opening state (no failures yet) an adaptive turn is
    // routine (T1) and the layer is off for the whole turn — it could never run on exactly the turns it exists for. Resolve
    // it as it would be after one failure, with this layer FIRST in the call budget (the fixed order spends a LOW-risk turn's
    // 3 calls on injection detection, contradiction and criterion coverage before it, starving the one layer a failure makes
    // relevant). Static and shadow are unchanged (the plan is the static one either way).
    let livePlan = escalationPlan
    const failurePlan = this.layerPolicyMode === 'adaptive' && complexitySignal.runState
      ? resolveEscalationPlan(this.layerPolicyMode, escalationSignals, { ...complexitySignal.runState, consecutiveFailures: Math.max(1, complexitySignal.runState.consecutiveFailures) }, undefined, { ...turnPolicyBudget(escalationSignals), priority: ['failure_match'] })
      : escalationPlan
    // Shadow mode records what adaptive would decide. Adaptive judges the failure matcher as it stands after a failure (above),
    // so the shadow record must too — otherwise the report says adaptive would skip it on turns that failed.
    const shadowFailureDecision = this.layerPolicyMode === 'shadow' && complexitySignal.runState
      ? resolveEscalationPlan('adaptive', escalationSignals, { ...complexitySignal.runState, consecutiveFailures: Math.max(1, complexitySignal.runState.consecutiveFailures) }, undefined, { ...turnPolicyBudget(escalationSignals), priority: ['failure_match'] }).policy.failure_match
      : undefined
    // AL9b: this turn's pushback tells us whether the PREVIOUS turn needed correcting.
    if (this.lastOutcomeRunId !== undefined) {
      recordLayerTelemetry(this.experienceStore, buildFeedbackRow(this.lastOutcomeRunId, classification.pushbackOnPriorTurn === true), `layer_outcome_feedback:${this.lastOutcomeRunId}`)
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
    // P4 — the auto-advance task-count ceiling (see PLAN_AUTO_ADVANCE_TASK_CEILING's doc
    // comment), consumed once per resolved task inside shouldPause below. Immutable Budget, so
    // this binding is reassigned rather than mutated in place.
    let autoAdvanceBudget = new Budget({ maxCalls: PLAN_AUTO_ADVANCE_TASK_CEILING })

    // Every layer's fired/skipped report this turn, structured so AssistantTrace.layerActivity
    // is populated the same "absent caller, still works" way nodeExecutionOrder/
    // verificationHealth already are.
    const layerActivityThisTurn: LayerActivityEvent[] = []
    // The last real VerificationResult this turn produced (a multi-task turn can call verify()
    // more than once; the last one reflects the final task's outcome) — feeds buildAnswerClaim
    // (ResponseService). null if verify() never ran at all this turn.
    let lastVerification: VerificationResult | null = null
    // Task id → why the completion check judged it not done, so the plan can remember it across turns.
    const taskNotes: Record<string, string> = {}

    let pausedThisTurn = false
    // Q2 — set (in the catch below) when a thrown EscalationHalt carries a populated
    // `blocker.questions` while askModeEnabled: the checkpoint just saved by the iteration
    // before the escalation must survive into `needs_clarification`'s resume instead of being
    // discarded as a terminal escalation, same as `pausedThisTurn` already protects a
    // plan-pacing pause's checkpoint.
    let preserveForClarification = false

    // The harness's WorldModel is scratch state, rebuilt empty every turn — without this, a
    // fact stated in an earlier turn is gone by the time a later turn's message might
    // contradict it, so Contradiction (and World Model's own belief trail) never has more
    // than one turn's own facts to work with, no matter how long the conversation runs. Seeded
    // once per turn (not once per task, unlike the current-turn extraction below) — every task
    // in a multi-task turn re-deriving the same prior beliefs would just duplicate them.
    // isNew:true marks a fact this turn's message actually stated — see harness-runtime.ts's
    // world_model layer_activity report, which only surfaces one of these as "Remembered: ...".
    // Computed once, outside factExtractor: ctx.objective never changes across tasks within one
    // run (harness-runtime.ts's buildInitialContext fixes it to the run's initial objective,
    // always this turn's userMessage for personal-assistant), so re-deriving it per call would
    // just repeat the same work. Phase 4: this is currentTurnFacts (memory-service.ts's
    // buildTurnFacts() merge of the lexical pass and classifyTurnIntent's statesDurableFacts),
    // not just the lexical pass — an LLM-caught fact is now visible to this turn's contradiction
    // detection immediately, not just written to the session store and left for a later turn's
    // re-seed. Deliberately unfiltered by tier here, same as before this phase: these are new
    // candidate statements to check against Knowledge, not Knowledge themselves.
    // AL8a: model_inferred_facts policy — a T1/off decision drops the LLM-derived seeds (lexical
    // user_asserted facts stay); env override and static default keep today's list.
    const seedFacts = escalationEnabled('model_inferred_facts', escalationPlan) ? currentTurnFacts : currentTurnFacts.filter(f => f.source !== 'model_inferred')
    const currentTurnFactStatements = seedFacts.map(f => ({ statement: f.text, isNew: true }))
    // Facts the semantic change reviewer checks a proposed change against (see the harness's
    // changeReviewFacts): Knowledge-tier facts from EARLIER turns, and only the ones the user
    // stated directly / that earned HIGH trust (factReliability) — an unconfirmed model_inferred
    // guess is not something to hold a change up against. This turn's own facts are deliberately
    // left out: the reviewer would compare a message with the statement it just made (a wasted
    // call, and a candidate false positive), and a same-turn fact plus request is already in front
    // of the model. Computed once per run; deliberately not routed through the world model (see
    // changeReviewFacts' doc comment).
    const changeReviewFactList = (() => {
      const seen = new Set<string>()
      return facts
        .filter(f => isKnowledgeTier(tierForFact(f)) && factReliability(f) === 'HIGH')
        .slice(-FACT_CAP)
        .map(f => ({ statement: f.text }))
        .filter(f => (seen.has(f.statement) ? false : (seen.add(f.statement), true)))
    })()
    let priorFactsSeeded = false
    const factExtractor = (_objective: string): Array<{ statement: string; isNew?: boolean }> => {
      // Prior facts are re-seeded so the contradiction checker has something to compare against,
      // but they're not new this turn and shouldn't be reported as if they were.
      if (priorFactsSeeded) return currentTurnFactStatements
      priorFactsSeeded = true
      // Phase E / criticism001 #8: contradiction detection reads the Knowledge tier only — a
      // model_inferred musing recorded on some earlier turn (classifyTurnIntent's unconfirmed
      // statesDurableFacts guess, see fact-extraction.ts's recordFacts doc comment) must not
      // re-enter the belief pool on a later turn and get treated as an established fact to
      // contradict against unless it earned Knowledge-tier promotion (Phase 4's tierForFact rule).
      const priorFacts = facts.filter(f => isKnowledgeTier(tierForFact(f))).slice(-FACT_CAP).map(f => ({ statement: f.text }))
      return [...priorFacts, ...currentTurnFactStatements]
    }

    // lexicalMode → HARNESS_LEXICAL_OFF, so the harness's own lexical floors follow the same switch.
    syncHarnessLexicalEnv()
    try {
      const runOptions = {
        initialTasks,
        // Every task in a decomposed graph executes against the same single draftReply —
        // PersonalAssistant still makes only one real content-generating LLM call per turn
        // (plus decomposeObjective's own call, when it ran). Decomposition changes the harness's
        // task-graph *shape* (visible in stepsUsed/nodeExecutionOrder), not the number of
        // distinct replies produced.
        //
        // R2 of the internal plan: flag-OFF (the default) and flag-ON
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
        // AL8b: the ad hoc harness gates read the executed policy (adaptive only — static/shadow
        // pass nothing, so today's outcomes are untouched) and re-resolve it each iteration with
        // fresh run state so an escalate-on-evidence rule can fire within the turn.
        layerPolicy: harnessGatePolicy(escalationPlan),
        reevaluateLayerPolicy: this.layerPolicyMode === 'adaptive'
          ? ({ failures }: { failures: number }) => {
              // Keep the plan the host hooks (hookEnabled below) read in step with the one the harness gates read.
              livePlan = resolveEscalationPlan(
                this.layerPolicyMode,
                { ...complexitySignal, isTrivial: classification.isTrivial },
                complexitySignal.runState ? { ...complexitySignal.runState, consecutiveFailures: failures } : undefined,
                undefined,
                turnPolicyBudget(escalationSignals),
              )
              return harnessGatePolicy(livePlan)
            }
          : undefined,
        // The semantic escalation hooks are wired below whenever the operator has not switched them off, and gated per call:
        // the plan can change mid-turn (reevaluateLayerPolicy above), so a layer a calm opening switched off can come back on
        // once evidence arrives. The failure matcher is only ever asked about a task that has failed, so it is judged by the
        // plan as it stands after a failure. Static and shadow: the plan never changes, so this is today's behaviour.
        hookEnabled: (layer: 'semantic_contradiction' | 'change_review' | 'failure_match' | 'criterion_coverage') =>
          escalationEnabled(layer, layer === 'failure_match' ? failurePlan : livePlan),
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
        // AUDIT_VERIFICATION (feature-value audit, Phase C5, eval-only) → skip verify() entirely.
        // Default ON — unchanged shipped behaviour; skipVerification stays undefined.
        skipVerification: verificationEnabled() ? undefined : true,
        // AUDIT_REVIEWER_PASS (feature-value audit, Phase C6, eval-only) → skip reviewerPass()
        // (and any reviewer_pass_2 re-run) entirely, including its C1/C2 sub-mechanisms. Default
        // ON — unchanged shipped behaviour; skipReviewerPass stays undefined.
        skipReviewerPass: reviewerPassEnabled() ? undefined : true,
        // AUDIT_CONTROL_STATE_GATE (feature-value audit, control_state, eval-only) → the harness's
        // own ControlState stays ALLOW/NORMAL (no gate BLOCK/ESCALATE). Default ON — unchanged.
        skipControlState: controlStateGateEnabled() ? undefined : true,
        // AUDIT_EXPERIENCE_LEARNING (default off): journal every executed task and teach the experience store when the run ends.
        experienceLearning: optInLayerEnabled('experience_learning', experienceLearningEnabled(), optInPlan) ? true : undefined,
        retryFailedTask: retryFailedTaskEnabled() ? true : undefined,
        retryFailedSystemErrors: retrySystemErrorsEnabled() ? true : undefined,
        // Trajectory Supervisor GATHER_EVIDENCE host (S5). Inert unless a supervisorDecider is
        // also wired and returns a GATHER_EVIDENCE directive at a stall edge; absent → the
        // harness degrades GATHER_EVIDENCE to CONTINUE.
        runInvestigation,
        // Trajectory Supervisor decider (S5) — the single stall-edge LLM call. Flag-gated on
        // HARNESS_TRAJECTORY_SUPERVISOR (aielia default ON since 2026-09-23 — supervisor-flag.ts); when off, the harness never consults it
        // and the whole supervisor path stays inert (INV-22). The harness itself only calls this
        // inside its own cannotMakeProgress() branch. Twin of the planner driver's _run_planner gate.
        supervisorDecider: resolveSupervisorEnabled()
          ? (digest: TrajectoryDigestData) => decideSupervisorDirective(digest, this.llmClient, this.model(), onUsage)
          : undefined,
        onSupervisorDirective: (directive: SupervisorDirective) => {
          this.onTrace?.({ kind: 'layer_activity', layer: 'supervisor', fired: directive.action !== 'CONTINUE', reason: `${directive.action}: ${directive.rationale}`.slice(0, 200) })
        },
        // Trajectory Supervisor ASK_USER host (S3) — its presence is what lets an ASK_USER
        // directive surface as a structured supervisor_question escalation instead of degrading
        // to a plain one. The escalation itself is carried out of run() as an EscalationHalt and
        // surfaced to the user by the sequencer; this hook is observability only.
        askUser: resolveSupervisorEnabled()
          ? (q: UserQuestionData) => {
              this.onTrace?.({ kind: 'layer_activity', layer: 'supervisor', fired: true, reason: `ASK_USER: ${q.question}`.slice(0, 200) })
            }
          : undefined,
        // Layered on top of the harness's own always-on lexical/negation-pair check — one call
        // per belief-set growth (never per-pair, never a full re-scan), and skipped entirely
        // when every newly-added belief looks like a structured/technical claim the lexical
        // check already covers. Filtered against AssistantSession's notifiedContradictions so an
        // unresolved conflict already surfaced once this session doesn't get independently
        // rediscovered and re-notified by every later turn's fresh, from-scratch WorldModel.
        // AUDIT_SEMANTIC_CONTRADICTION (feature-value audit, Phase A4) gates the whole hook: OFF
        // → no host contradictionChecker is wired at all, so the harness runs its always-on
        // lexical / negation-pair check only. Default ON — unchanged shipped behaviour.
        contradictionChecker: escalationHookWired('semantic_contradiction')
          ? async (newBeliefs: BeliefCandidate[], existingBeliefs: BeliefCandidate[]) => {
              const { contradictions } = await checkForContradictions(newBeliefs, existingBeliefs, this.llmClient, this.model(), usageFor('semantic_contradiction'))
              const statementById = new Map([...newBeliefs, ...existingBeliefs].map((b) => [b.id, b.statement]))
              const seen = await this.assistantSession.getNotifiedContradictions(sessionId)
              const filtered: typeof contradictions = []
              for (const c of contradictions) {
                const signature = [...c.beliefIds].map((id) => statementById.get(id) ?? id).sort().join(' ')
                if (seen.has(signature)) continue
                await this.assistantSession.recordNotifiedContradiction(sessionId, seen, signature)
                filtered.push(c)
              }
              return filtered
            }
          : undefined,
        // Layered on top of review-proposed-change.ts's lexical isNegation check — same "skip
        // when it reads like a coding fact" gate contradictionChecker uses, since that's the
        // domain the fixed-phrase check already covers reasonably well.
        // AUDIT_SEMANTIC_CHANGE_REVIEW (feature-value audit, Phase C2) gates the whole hook: OFF →
        // no host semanticChangeReviewer is wired at all, so the harness's mechanical
        // reviewProposedChange (lexical isNegation) is the only conflict check. Default ON —
        // unchanged shipped behaviour.
        changeReviewFacts: () => changeReviewFactList,
        onReviewConflict,
        onFailureModeSwitch,
        onLearnedStrategySwitch,
        // AUDIT_SEMANTIC_HYPOTHESES (default off): ask once for competing explanations, but only for a request the
        // classifier judged underdetermined — every other turn keeps the template seeds and pays for no call.
        // The judge is wired alongside, and the harness only consults it once semantic hypotheses exist.
        // AUDIT_REVIEWER_REVISION (default off): let a reviewer finding at the end of a run send the last answer back once.
        // Only where there is a proposer to re-ask — a tool-less turn's reply is already drafted, so a second run would return
        // the same text.
        // The generic default criterion is never checkable, so the implementer lens always flagged it "not covered" (243 of 243
        // reviewer findings across the eval transcripts) — skipped in the default flow too, not only with the flag on.
        isCheckableCriterion,
        // AUDIT_HARNESS_TOKEN_BUDGET (default off): the memory layer's token budget, fed from this turn's real usage.
        ...(harnessTokenBudgetTotal() !== undefined && tokensUsed ? { tokenBudget: { total: harnessTokenBudgetTotal()!, used: tokensUsed } } : {}),
        ...(optInLayerEnabled('reviewer_revision', reviewerRevisionEnabled(), optInPlan) && oneLoopProposer
          ? { reviewerRevision: reviewerRevisionNote, onReviewerRevision }
          : {}),
        ...(optInLayerEnabled('semantic_hypotheses', semanticHypothesesEnabled(), optInPlan) && classification.isUnderdetermined === true
          ? {
              semanticHypotheses: (input: { objective: string; observations: string[]; beliefs: string[] }) =>
                precomputedHypotheses !== undefined
                  ? Promise.resolve(precomputedHypotheses)
                  : proposeCompetingExplanations({ request: userMessage, observations: input.observations, beliefs: input.beliefs }, this.llmClient, this.model(), onUsage),
              semanticHypothesisJudge: (input: { hypotheses: Array<{ id: string; explanation: string; predicted_observations: string[] }>; observations: string[] }) =>
                judgeHypothesesAgainstEvidence(input, this.llmClient, this.model(), onUsage),
              onSemanticHypothesis,
            }
          : {}),
        semanticChangeReviewer: escalationHookWired('change_review')
          ? (input: { changeDescription: string; highConfidenceBeliefs: BeliefCandidate[]; hypothesisPredictions: string[] }) =>
              checkSemanticReviewConflict(input.changeDescription, input.highConfidenceBeliefs, input.hypothesisPredictions, this.llmClient, this.model(), usageFor('change_review'))
          : undefined,
        // Layered on top of FailureModeLibrary's own exact-string-overlap match() — see
        // failure-mode-matcher.ts's doc comment for why exact equality against a curated symptom
        // list almost never happens for free-text observations in practice.
        // AUDIT_SEMANTIC_FAILURE_MATCH (feature-value audit, Phase A6) gates the whole hook: OFF →
        // no host semanticFailureMatcher is wired at all, so the harness runs its exact-match
        // FailureModeLibrary.match() only. Default ON — unchanged shipped behaviour.
        semanticFailureMatcher: escalationHookWired('failure_match')
          ? (symptoms: string[], libraryEntries: readonly FailureModeEntry[]) =>
              checkSemanticFailureMatch(symptoms, libraryEntries, this.llmClient, this.model(), usageFor('failure_match'))
          : undefined,
        // Layered on top of reviewerPass's implementerLens's own `.includes()` substring check —
        // called only for a success criterion that substring check found no coverage for. See
        // semantic-criterion-coverage.ts's doc comment.
        // AUDIT_SEMANTIC_CRITERION_COVERAGE (feature-value audit, Phase C1) gates the whole hook:
        // OFF → no host semanticCriterionCoverage is wired at all, so the reviewer's implementer
        // lens runs its `.includes()` substring check alone. Default ON — unchanged shipped behaviour.
        semanticCriterionCoverage: escalationHookWired('criterion_coverage')
          ? (criterion: string, beliefs: Belief[]) =>
              checkSemanticCriterionCoverage(criterion, beliefs, this.llmClient, this.model(), usageFor('criterion_coverage'))
          : undefined,
        // A plan task is complete only if its output actually did the task — without this the harness
        // completes it as soon as a reply is produced, so a run of refusals reads as a 100%-done plan.
        // Scoped to an approved plan's execution (not an ordinary single-task turn) and off by default:
        // AUDIT_SEMANTIC_TASK_COMPLETION. See task-completion-check.ts.
        onTaskNotAccomplished: (e: { taskId: string; reason: string }) => { taskNotes[e.taskId] = e.reason },
        // The lexical caller-constraint check throws on a reply that merely names the constraint's subject; this judges
        // the reply against the constraints instead (AUDIT_SEMANTIC_CONSTRAINT_CHECK, default on). See constraint-check.ts.
        semanticConstraintJudge: semanticConstraintCheckEnabled()
          ? (input: { constraints: string[]; reply: string }) => checkConstraints(input, this.llmClient, this.model(), onUsage)
          : undefined,
        // The constraints the user has stated this session (earlier turns' plus this turn's, from the classifier). Fed to the
        // harness only where the semantic judge replaces the lexical match (a word match would fail an acknowledging reply)
        // AND there is a proposer to ask again — a violation sends the answer back once, and a tool-less turn's reply is
        // already drafted. Persisted per session by assistant.ts (AssistantSession.recordStandingConstraints).
        ...(standingConstraints.length > 0 ? { callerConstraints: standingConstraints, onConstraintRevision } : {}),
        semanticTaskCompletion:
          activePlan?.executingOnPlan && semanticTaskCompletionEnabled()
            ? (input: { taskDescription: string; output: unknown }) => checkTaskCompletion(input, this.llmClient, this.model(), onUsage)
            : undefined,
        // Stop right after a MEDIUM/HIGH-risk plan step resolves (COMPLETE or FAILED), before
        // the loop would go pick the next one — undefined for a non-plan turn, so shouldPause is
        // simply never checked and behavior is unchanged.
        //
        // P4: once the plan itself has been through P2's mandatory approval (`executingOnPlan`),
        // that per-step risk pause is redundant and removed — an approved plan auto-advances
        // through its whole unblocked frontier. A plan that somehow reached `active` without
        // `executingOnPlan` ever being set true (there should be none, per INV-31, but this is a
        // safety net for a pre-P0-migration record) keeps today's conservative risk-based pause.
        // Auto-advance still stops at PLAN_AUTO_ADVANCE_TASK_CEILING resolved tasks regardless —
        // a distinct, always-on ceiling, not a reintroduction of the risk check.
        shouldPause: planPacing
          ? (cp: HarnessCheckpoint) => {
              if (cp.progress.nodeExecutionOrder.at(-1) !== 'update_task_state') return false
              let pause = false
              let resolvedThisCheck = 0
              for (const t of cp.runState.taskGraph.tasks) {
                const prevStatus = planPacing.lastStatusById.get(t.id)
                if (prevStatus !== t.status && (t.status === 'COMPLETE' || t.status === 'FAILED')) {
                  resolvedThisCheck++
                  if (!activePlan?.executingOnPlan) {
                    const risk = planPacing.riskById.get(t.id)
                    if (risk === 'MEDIUM' || risk === 'HIGH') pause = true
                  }
                }
                planPacing.lastStatusById.set(t.id, t.status)
              }
              if (activePlan?.executingOnPlan) {
                autoAdvanceBudget = autoAdvanceBudget.consume({ calls: resolvedThisCheck })
                if (autoAdvanceBudget.isExhausted()) pause = true
              }
              // A pause is only worth keeping when something is left to run. When the task that just resolved was the
              // plan's last (the ceiling is hit exactly on the final step), pausing would leave a finished run's checkpoint
              // behind, and the NEXT turn — whatever the user said — would resume it and answer with that run's stale result
              // instead of the new message.
              if (pause && !cp.runState.taskGraph.tasks.some((t) => t.status === 'PENDING' || t.status === 'RUNNING')) pause = false
              return pause
            }
          : undefined,
        // Q2 — see HarnessRunParams.askModeEnabled/updateChannel's doc comments.
        askMode: askModeEnabled ? ('enabled' as const) : ('disabled' as const),
        updateChannel,
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
            planTasks: activePlan ? checkpoint.runState.taskGraph.tasks.map((t) => ({ id: t.id, status: t.status })) : undefined,
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
            // The plan's own criterion when a durable plan is driving this run — without it the
            // reviewer's implementer lens only ever saw the non-checkable default (which
            // checkSemanticCriterionCoverage skips on sight), so the criterion-coverage hook was
            // unreachable for real traffic. Ad hoc turns keep the default, byte-identical.
            activePlan?.successCriteria.trim() ? [activePlan.successCriteria.trim()] : [NON_CHECKABLE_DEFAULT_CRITERION],
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
        this.recordTurnTelemetry(runId, escalationPlan, layerActivityThisTurn, lastVerification, false, { layerUse, shadowFailureDecision })
        return { status: 'paused', checkpoint: outcome.checkpoint, lastVerification, layerActivity: layerActivityThisTurn, taskNotes }
      }

      this.recordTurnTelemetry(runId, escalationPlan, layerActivityThisTurn, lastVerification, true, { layerUse, shadowFailureDecision })
      return { status: 'completed', result: outcome.result, lastVerification, layerActivity: layerActivityThisTurn, taskNotes }
    } catch (err) {
      // Q2 — inspected only to decide checkpoint retention below, never transformed or
      // swallowed: EscalationHalt still propagates out of run() unexamined otherwise, exactly as
      // the class doc comment promises, so the sequencer's single try/catch
      // (assistant.ts/ResponseService/AskClarificationService) still does the actual handling.
      if (err instanceof EscalationHalt && askModeEnabled && err.blocker.questions && err.blocker.questions.length > 0) {
        preserveForClarification = true
      }
      throw err
    } finally {
      // A completed or genuinely-escalated (terminal halt) turn has nothing left to resume, so
      // drop the checkpoint — but an intentional plan-pacing pause, or a structured-question
      // escalation about to become `needs_clarification`, must keep it, so a later turn() call's
      // priorCheckpoint branch (here, via AskClarificationService.resolvePendingClarification)
      // resumes this same run instead of starting a fresh one. Any other EscalationHalt thrown
      // out of runtime.run()/resume() above propagates straight through this finally
      // (pausedThisTurn/preserveForClarification both stay false, so its checkpoint is still
      // cleaned up here) to the sequencer's own try/catch.
      if (!pausedThisTurn && !preserveForClarification) {
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
