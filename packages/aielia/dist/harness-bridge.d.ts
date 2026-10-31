import { ExperienceStore, Task, CheckpointStore, LayerActivityEvent, HarnessCheckpoint, VerificationResult, HarnessRunResult, ToolExecutorContext, InvestigationRequestData, InvestigationFinding, UpdateChannel, SemanticHypothesisEvent, SemanticHypothesisProposal, LayerPolicyMode } from '@buildaharness/harness';
import { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime';
import { OneLoopMode } from './one-loop-flag.js';
import { UserFact } from './fact-extraction.js';
import { AssistantSession } from './assistant-session.js';
import { PlanRecord } from './plan-store.js';
import { PlanService } from './plan-service.js';
import { TurnIntentClassification } from './turn-intent-classifier.js';
import { AssistantSource } from './assistant-source.js';
import { AssistantProgress } from './assistant-types.js';
import { TraceEvent } from './trace-events.js';
import { EscalationPlan } from './layer-policy-wiring.js';
/**
 * `AUDIT_VERIFICATION` gate — feature-value audit (Phase C5 of the internal plan). Default **ON** (an
 * unset / empty / truthy value keeps today's always-on verification). A falsy value (`0` / `false` /
 * `off` / `no` / `disabled`) makes `HarnessBridge.run` pass `skipVerification: true` to HarnessRuntime.
 * Set by the benchmark's `verificationOff` arm and by the user's `mandatory_verification` layer setting
 * (`layer-settings.ts`). Read at exactly one call site (below). Same shape as `semanticContradictionEnabled()`.
 */
export declare function verificationEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * `AUDIT_EXPERIENCE_LEARNING` gate. Default **OFF**: the harness never writes its journal or updates the experience store, so
 * `warmStart` / the recovery ladder keep reading an empty store, exactly as before. A truthy value (`1` / `true` / `on` / `yes` /
 * `enabled`) makes HarnessBridge.run pass `experienceLearning: true` — see packages/harness/src/experience-learning.ts. It changes
 * how a LATER run orders its recovery strategies, so it ships off until a benchmark shows it helps. Read at one site (below).
 */
export declare function experienceLearningEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * `AUDIT_RETRY_FAILED_TASK` gate. Default **OFF**. On (`1`/`true`/`on`/`yes`/`enabled`) makes HarnessBridge.run pass
 * `retryFailedTask: true`: after the recovery ladder switches strategy for a failed task, the failed task is re-queued so the
 * new strategy actually gets an attempt (HarnessRunOptions.retryFailedTask). Off, a failed single task — or a multi-task turn
 * whose tasks fail together — ends with nothing to run and the turn answers "could not complete". Read fresh each run.
 */
export declare function retryFailedTaskEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * `AUDIT_RETRY_SYSTEM_ERRORS` gate. Default **ON** (`0`/`false`/`off`/`no`/`disabled` restores the old behaviour). Makes
 * HarnessBridge.run pass `retryFailedSystemErrors: true`: after the recovery ladder switches strategy for a task whose failure
 * was a SYSTEM error (the model or a tool call threw), the task is re-queued so the new strategy gets an attempt, instead of
 * the turn giving up with "I couldn't complete this" after one transient error. An exhausted tool-loop budget, a rejected
 * completion check and a failed verification are NOT retried (the wider `AUDIT_RETRY_FAILED_TASK` retries those too and stays
 * off). Bounded by the ladder's MAX_SWITCHES and the stall rule. Read fresh each run.
 */
export declare function retrySystemErrorsEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * `AUDIT_REVIEWER_PASS` gate — feature-value audit (Phase C6 of the internal plan). EVAL-ONLY:
 * default **ON** (an unset / empty / truthy value keeps today's always-on 3-lens reviewer pass).
 * Only the benchmark's `reviewerPassOff` arm sets a falsy value (`0` / `false` / `off` / `no` /
 * `disabled`), which makes `HarnessBridge.run` pass `skipReviewerPass: true` to HarnessRuntime.
 * Read at exactly one call site (below); no product path sets it. Same shape as
 * `verificationEnabled()`.
 */
export declare function reviewerPassEnabled(env?: Record<string, string | undefined>): boolean;
export type HarnessOutcome = {
    status: 'paused';
    checkpoint: HarnessCheckpoint;
    lastVerification: VerificationResult | null;
    layerActivity: LayerActivityEvent[];
    taskNotes: Record<string, string>;
} | {
    status: 'completed';
    result: HarnessRunResult;
    lastVerification: VerificationResult | null;
    layerActivity: LayerActivityEvent[];
    taskNotes: Record<string, string>;
};
export interface HarnessRunParams {
    sessionId: string;
    userMessage: string;
    facts: UserFact[];
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
    currentTurnFacts?: UserFact[];
    draftReply: string;
    classification: TurnIntentClassification;
    initialTasks: Task[];
    activePlan: PlanRecord | null;
    sources: AssistantSource[] | undefined;
    onProgress?: (progress: AssistantProgress) => void;
    onUsage: (usage: TokenUsage) => void;
    /**
     * R2 of the internal plan: a harness-driven proposer (built by
     * AgentLoop.createHarnessProposer) swapped in as the toolExecutors 'default' entry instead of
     * `() => draftReply`, when the one-loop flag is enabled and a caller actually supplies one.
     * `undefined` (every caller today, before R3 wires runTurn to build one) means `run()` falls
     * back to `() => draftReply` regardless of the flag — R2 only builds the mechanism and proves it
     * against a caller that supplies this directly; wiring runTurn to always supply one when the
     * flag is on is R3's scope.
     */
    oneLoopProposer?: (toolCtx: ToolExecutorContext) => unknown | Promise<unknown>;
    /** Semantic change reviewer found a conflict — advisory (see HarnessRunOptions.onReviewConflict). The caller decides how to surface it. */
    onReviewConflict?: (event: {
        taskId: string;
        reason: string;
    }) => void;
    /** Competing explanations were generated for an underdetermined request, or one was eliminated by evidence (AUDIT_SEMANTIC_HYPOTHESES). The caller decides how to surface it. */
    onSemanticHypothesis?: (event: SemanticHypothesisEvent) => void;
    /** The competing explanations were already asked for (a tool-less turn drafts its reply first): the harness registers this answer instead of making a second call. `null` = asked, none. `undefined` = not asked. */
    precomputedHypotheses?: SemanticHypothesisProposal[] | null;
    /** The opt-in layers' plan for this turn (adaptive mode only); see resolveOptInPlan. Absent: each layer's own flag decides. */
    optInPlan?: EscalationPlan;
    /** The reviewer pass's verdict sent the last answer back for one revision (AUDIT_REVIEWER_REVISION): the note to put in front of the proposer. */
    onReviewerRevision?: (event: {
        taskId: string;
        note: string;
    }) => void;
    /** A constraint the user stated this turn was violated by the finished answer: the note to hand the proposer for its one second answer. */
    onConstraintRevision?: (event: {
        taskId: string;
        note: string;
    }) => void;
    /** Tokens this turn's model calls have used so far (input + output) — what AUDIT_HARNESS_TOKEN_BUDGET reports to the harness. */
    tokensUsed?: () => number;
    /** A confident failure-mode match picked the recovery strategy — advisory (see HarnessRunOptions.onFailureModeSwitch). The caller decides how to surface it. */
    onFailureModeSwitch?: (event: {
        taskId: string;
        failure_class: string;
        strategy: string;
    }) => void;
    /** With AUDIT_EXPERIENCE_LEARNING on, a ranking learned from earlier runs picked the recovery strategy — advisory (see HarnessRunOptions.onLearnedStrategySwitch). */
    onLearnedStrategySwitch?: (event: {
        taskId: string;
        failure_class: string;
        strategy: string;
    }) => void;
    /**
     * Trajectory Supervisor GATHER_EVIDENCE host (S5 of
     * the internal plan) — AgentLoop.runSupervisorInvestigation bound
     * to this turn's read-only tools + risk hint. Passed straight through to
     * HarnessRunOptions.runInvestigation. `undefined` (every caller until a supervisorDecider is
     * also wired) → GATHER_EVIDENCE degrades to CONTINUE inside the harness, so this is inert by
     * default exactly like onSupervisorDirective.
     */
    runInvestigation?: (req: InvestigationRequestData) => Promise<InvestigationFinding[]>;
    /**
     * Q2 of the internal plan — the already-resolved effective askMode
     * (Q1's three-tier INV-29 resolution), threaded straight into HarnessRunOptions.askMode so the
     * harness's own supervisor ASK_USER path (S3) batches questions consistently with
     * AskClarificationService's own gating. Also decides whether a thrown EscalationHalt carrying
     * a populated `blocker.questions` gets to keep its checkpoint alive (see the `finally` block
     * below) instead of being deleted as a terminal escalation. Defaults to false — byte-identical
     * to pre-Q2 behavior when omitted.
     */
    askModeEnabled?: boolean;
    /**
     * Q2 — AskClarificationService.resolvePendingClarification's one-shot channel carrying the
     * user's AskResponse back into the paused run's `callerState` via the harness's own
     * checkCallerUpdates/applyConstraintChangePropagation path (nodes/check-caller-updates.ts).
     * Passed straight through to HarnessRunOptions.updateChannel; undefined (every caller before
     * Q2) defaults to a no-op channel inside the harness, unchanged.
     */
    updateChannel?: UpdateChannel;
}
/**
 * HarnessRuntime construction + invocation: the runOptions assembly, checkpoint load +
 * RESUME_ATTEMPT_CAP logic, runtime.run()/.resume() dispatch, and the paused-vs-completed
 * outcome split — split out of runTurn in Phase 4d of the architecture remediation plan.
 * `EscalationHalt` is deliberately NOT caught here — it propagates out of `run()` so the
 * sequencer's single try/catch still handles it (assistant.ts's runTurn/ResponseService).
 */
export declare class HarnessBridge {
    private readonly memory;
    private readonly experienceStore;
    private readonly checkpointStore;
    private readonly llmClient;
    private readonly model;
    private readonly maxSteps;
    private readonly planService;
    private readonly assistantSession;
    private readonly onTrace;
    private readonly oneLoopMode;
    private readonly layerPolicyMode;
    constructor(memory: MemoryAdapter, experienceStore: ExperienceStore, checkpointStore: CheckpointStore, llmClient: ILLMClient, model: () => string | undefined, maxSteps: number, planService: PlanService, assistantSession: AssistantSession, onTrace: ((event: TraceEvent) => void) | undefined, oneLoopMode?: OneLoopMode, layerPolicyMode?: LayerPolicyMode);
    /** AL9b: runId of the previous turn's outcome row, so this turn's `pushbackOnPriorTurn` can be recorded against it. */
    private lastOutcomeRunId;
    private outcomeSeq;
    /** AL9b: persist the per-layer outcome row (and, under shadow, the shadow-vs-executed row). Never throws, never affects the turn. */
    private recordTurnTelemetry;
    /**
     * Drops the paused harness run a `needs_clarification` left behind (its checkpoint and its resume-attempt counter),
     * so the next ordinary run for this session starts fresh instead of resuming it. Used when a clarification answer
     * is handed to the ordinary turn pipeline rather than fed back into the paused run.
     */
    discardPausedRun(sessionId: string): Promise<void>;
    run(params: HarnessRunParams): Promise<HarnessOutcome>;
}
