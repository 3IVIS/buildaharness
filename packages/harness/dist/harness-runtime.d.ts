import { ExperienceStore } from './state/experience-store.js';
import { ExternalContradictionInput } from './nodes/detect-contradictions.js';
import { ToolExecutorContext } from './nodes/execute.js';
import { VerificationResult } from './nodes/verify.js';
import { SupervisorDirective, SupervisorDirectiveData, InvestigationRequestData, UserQuestionData } from './supervisor.js';
import { InvestigationFinding } from './investigation.js';
import { TrajectoryDigestData } from './trajectory-digest.js';
import { UpdateChannel } from './nodes/check-caller-updates.js';
import { SemanticCriterionCoverage, ReviewerVerdict, CriterionCheckable } from './nodes/reviewer-pass.js';
import { OutputValidationResult } from './nodes/output-validation.js';
import { HarnessInitOptions, HarnessInitResult } from './nodes/initialize.js';
import { HarnessCheckpoint } from './harness-checkpoint.js';
import { FailureModeEntry } from './state/failure-diagnostics.js';
import { TurnSignals } from './turn-signals.js';
import { Decision as LayerDecisionValue, LayerPolicy } from './layer-policy.js';
export declare const BUDGET_WARNING_FLOOR = 0.5;
/**
 * One shared per-turn complexity signal, computed once by the caller (see
 * personal-assistant's assistant.ts) from data it already has — the risk classifier's
 * verdict, how many tasks this turn's graph has, whether a durable cross-turn plan is
 * driving it, and which tool kinds this turn's tasks touch. Read by the Phase 2 per-layer
 * trigger conditions instead of each layer inventing its own gating heuristic (see
 * the internal plan, Design Principle 2). `consequentialTools`
 * is a bare string set (not a closed union) so the generic runtime never hardcodes any one
 * caller's tool names — well-known values in personal-assistant are 'read_file',
 * 'list_directory', 'web_search', 'fetch_url', 'write_file', 'run_shell_command'.
 */
/**
 * Host hook: did this task's output actually accomplish the task? The harness otherwise marks a task
 * COMPLETE as soon as its executor returns without throwing, so a reply that refuses or asks a
 * question completes the task all the same. `done: false` sends the task down the same failure path
 * a thrown executor takes (recovery ladder, bounded retries, stall escalation) instead of COMPLETE.
 * Absent ⇒ today's behaviour. A hook that throws is treated as `done: true`.
 */
/**
 * The host's judgment of whether a finished reply breaks a constraint the caller set mid-run. When supplied it
 * REPLACES the lexical word match in output validation; a positive violation fails validation exactly as the
 * lexical check did, and a judge that throws or answers nothing passes the reply (fail-open).
 */
export type SemanticConstraintJudge = (input: {
    constraints: string[];
    reply: string;
}) => Promise<{
    violated: Array<{
        constraint: string;
        reason?: string;
    }>;
}>;
export type SemanticTaskCompletion = (input: {
    taskDescription: string;
    output: unknown;
}) => Promise<{
    done: boolean;
    reason?: string;
}>;
/** One competing explanation a host proposes for the request (see `SemanticHypothesesHook`). */
export interface SemanticHypothesisProposal {
    explanation: string;
    /** What you would expect to see if this explanation were true. */
    predicted_observations: string[];
    /** The check or observation that would separate this explanation from the others. */
    separating_check?: string;
    confidence?: number;
}
/**
 * Optional host hook (an LLM call, in aielia): propose 2+ competing explanations for an underdetermined request.
 * Called at most once per run, at the hypothesis step, only when the host wired it. Returning null or an empty list —
 * or throwing — leaves the run exactly as it was: the template seeds `generateUpdateHypotheses` produces stay, nothing
 * else changes. The proposals join the active set tagged `generation_sources: ['semantic']`.
 */
export type SemanticHypothesesHook = (input: {
    objective: string;
    observations: string[];
    beliefs: string[];
}) => Promise<SemanticHypothesisProposal[] | null>;
/**
 * Optional host hook: given the semantic hypotheses still active and the observations gathered since it last ran, say which
 * ones the evidence contradicts. Replaces the negation-word overlap the Python twin uses for the same job. Fails open like
 * the other hooks (null / throw ⇒ nothing is eliminated).
 */
export type SemanticHypothesisJudge = (input: {
    hypotheses: Array<{
        id: string;
        explanation: string;
        predicted_observations: string[];
    }>;
    observations: string[];
}) => Promise<{
    contradicted: Array<{
        id: string;
        reason?: string;
    }>;
} | null>;
export type SemanticHypothesisEvent = {
    kind: 'generated';
    hypotheses: Array<{
        id: string;
        explanation: string;
        predicted_observations: string[];
        separating_check?: string;
    }>;
} | {
    kind: 'eliminated';
    id: string;
    explanation: string;
    reason?: string;
};
/**
 * Optional host hook: given the reviewer pass's pending verdict at the END of a run (every task done, nothing already
 * reopened), return the text to put in front of the proposer, or null to leave the answer alone. Returning text reopens
 * the last task to complete so it runs once more — at most once per run — and fires `onReviewerRevision` with that text
 * so the host can deliver it. Absent ⇒ today's behaviour: the verdict only feeds the next resolver call.
 */
export type ReviewerRevision = (verdict: ReviewerVerdict) => string | null;
export interface TurnComplexitySignal {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    taskCount: number;
    hasDurablePlan: boolean;
    consequentialTools: Set<string>;
}
/**
 * Phase D1: the BLOCK/ESCALATE consequence, surfaced. Before this, action_gate's BLOCK/ESCALATE
 * branch just reset the task to PENDING and either threw EscalationHalt or silently looped —
 * the specific decision was invisible to the caller. `haltedRun` mirrors the very next thing
 * driveMainLoop does: true means cannotMakeProgress already found a stall and an
 * EscalationHalt throw immediately follows this event.
 */
export interface GateDecisionEvent {
    taskId: string;
    result: 'BLOCK' | 'ESCALATE';
    reason: string | null;
    haltedRun: boolean;
}
/** Emitted once per layer per main-loop iteration — see HarnessRunOptions.onLayerActivity. */
export interface LayerActivityEvent {
    layer: 'world_model' | 'evidence_reasoning' | 'hypothesis' | 'contradiction' | 'diagnostics' | 'control_state' | 'planning' | 'execution' | 'verification' | 'recovery' | 'reviewer_pass';
    fired: boolean;
    reason: string;
    /** AL7a (additive; older consumers unaffected): the layer policy's decision, its trigger, and what the layer cost this iteration. */
    decision?: LayerDecisionValue;
    trigger?: string;
    llmCalls?: number;
    tokens?: number;
}
export interface HarnessRunOptions extends HarnessInitOptions {
    /** Identifies this run for checkpointing. Auto-generated if omitted. */
    runId?: string;
    experienceStore?: ExperienceStore;
    updateChannel?: UpdateChannel;
    /**
     * Phase D2: a toolFn may return a Promise — driveMainLoop always awaits the result (see
     * execute.ts), so a real async proposer (e.g. one LLM round trip + tool dispatch) can sit
     * behind this exactly like today's synchronous ones. A plain synchronous toolFn (every one
     * written before this phase) is unaffected — awaiting a non-Promise value just resolves to
     * itself.
     */
    toolExecutors?: Record<string, (toolCtx: ToolExecutorContext) => unknown | Promise<unknown>>;
    /** Called after every checkpointable main-loop iteration. Persist the checkpoint here to support resume(). */
    onCheckpoint?: (checkpoint: HarnessCheckpoint) => void | Promise<void>;
    /** Return true to stop the run at the next checkpoint instead of running to completion. */
    shouldPause?: (checkpoint: HarnessCheckpoint) => boolean;
    /**
     * Optional hook: given the run's objective, return durable facts a caller has already
     * extracted from it. Called once per successfully executed task; each returned fact is
     * written into the world model as an INFERENCE belief (see updateWorldModel), giving World
     * Model/Contradiction/Reviewer real content instead of the observation-only default. The
     * harness itself has no fact-extraction logic of its own — this stays a caller-supplied hook
     * so the generic runtime never depends on any one caller's extraction heuristic.
     *
     * `isNew` (optional, defaults falsy) distinguishes a fact genuinely stated this turn from one
     * the caller re-seeded from prior turns for the contradiction checker's benefit — see the
     * world_model layer_activity report below, which only surfaces an `isNew` fact as "Remembered:
     * ...", not whichever carried-over fact happens to be first in the array.
     */
    factExtractor?: (objective: string) => Array<{
        statement: string;
        isNew?: boolean;
    }>;
    /** See TurnComplexitySignal — absent means every Phase 2 gate reads its own conservative default. A `TurnSignals` (AL5a) is a compatible superset. */
    complexitySignal?: TurnSignals;
    /**
     * AL8b: the resolved layer policy for this turn. Absent (or static triggers) ⇒ every gate keeps
     * today's outcome. Consumed by `resolveGate` at the ad hoc gates below.
     */
    layerPolicy?: LayerPolicy;
    /**
     * AL8b: iteration-boundary re-evaluation. Called after each iteration's `updateDiagnostics` with
     * the fresh loop state; the returned policy (if any) replaces `layerPolicy` for later gates in
     * the same turn so escalate-on-evidence works. Absent ⇒ the policy is fixed for the turn. A
     * throwing callback keeps the previous policy (AL-4).
     */
    reevaluateLayerPolicy?: (info: {
        iteration: number;
        diagnostics: HarnessInitResult['diagnostics'];
        failures: number;
    }) => LayerPolicy | undefined;
    /** Fired or skipped, every one of the 11 harness layers reports itself here each iteration — see LayerActivityEvent. */
    onLayerActivity?: (event: LayerActivityEvent) => void;
    /**
     * Called once per main-loop iteration right after the verification layer runs, with that
     * iteration's full `VerificationResult` (every layer's PASS/FAIL/SKIPPED, not just the
     * has_critical_failure summary `LayerActivityEvent.reason` collapses it to). Lets a caller
     * build a real epistemic-honesty signal (e.g. personal-assistant's AnswerClaim, Phase 6 of
     * the harness remediation plan) from the same real verification logic Phase 2/3 made
     * honest, instead of re-deriving a weaker proxy from `onLayerActivity`.
     */
    onVerification?: (result: VerificationResult) => void;
    /**
     * EVAL-ONLY ablation seam (feature-value audit, Phase C5) — default absent/false = today's
     * behaviour. When true the main loop skips the `verify()` call entirely and treats the
     * iteration's verification as an empty pass (no layer results, no critical failure);
     * `onVerification` is not fired, so a caller sees no verification result for the turn. No
     * product path sets this: the only caller is the benchmark arm's env flag in aielia's
     * harness-bridge. The Python twin has no equivalent — the ablation arm is PA-only.
     */
    skipVerification?: boolean;
    /**
     * EVAL-ONLY ablation seam (feature-value audit, Phase C6) — default absent/false = today's
     * behaviour. When true, `drive()` skips the `reviewerPass()` call (and any `reviewer_pass_2`
     * re-run) entirely: `'reviewer_pass'`/`'reviewer_pass_2'` are omitted from
     * `nodeExecutionOrder`, no task is reopened, and `pendingReviewerVerdict` is never set for this
     * turn's resolveAndStamp(). `semanticCriterionCoverage` (Phase C1) and `semanticChangeReviewer`
     * (Phase C2) are sub-mechanisms invoked from inside the reviewer pass, so this also disables
     * them — that is intended, this seam prices the whole pass. No product path sets this: the only
     * caller is the benchmark arm's env flag in aielia's harness-bridge. The Python twin has no
     * equivalent — the ablation arm is PA-only.
     */
    skipReviewerPass?: boolean;
    /**
     * EVAL-ONLY ablation seam (feature-value audit, control_state) — default absent/false = today's
     * behaviour. When true, `resolveAndStamp()` returns without resolving, so the harness's own
     * ControlState stays at its initial ALLOW/NORMAL: no gate BLOCK/ESCALATE from a resolver DENY, no
     * reviewer-verdict CAUTIOUS. The pending reviewer verdict is still consumed so it cannot pile up.
     * Stall detection (`cannotMakeProgress`) reads strategy/failure state, not ControlState, so it is
     * unaffected. No product path sets this: the only caller is the benchmark arm's env flag in
     * aielia's harness-bridge. The Python twin has no equivalent — the ablation arm is PA-only.
     */
    skipControlState?: boolean;
    /**
     * Opt-in cross-run learning (the feed for `warmStart` / `buildStrategyOrdering`): every executed task appends a journal entry,
     * and when the run ends (completes, or halts) the journal updates the experience store's strategy weights and failure-class
     * priors — see experience-learning.ts. A paused run does not learn (it resumes and would count its earlier entries twice).
     * Absent/false ⇒ the journal is never written and the store is never updated, exactly as before.
     */
    experienceLearning?: boolean;
    /** `sample` records strategy evidence and promotes only past a minimum sample and a Wilson bound (strategy-evidence.ts); default `single` is the legacy one-success rule. */
    experienceLearningRule?: 'single' | 'sample';
    /** Receives strategy_promoted / strategy_demoted events from the sample rule. */
    onStrategyEvent?: (event: import('./strategy-evidence.js').StrategyEvent) => void;
    /**
     * Opt-in: after the recovery ladder switches strategy for a failed task, re-queue every failed leaf so the new strategy
     * actually gets an attempt. Without it a LOCAL replan re-queues only the failed task's dependents (and the failed leaf itself
     * only after a supervisor redirect / evidence run / curated failure-mode match, and only when nothing else is pending), so a
     * one-node turn — or a multi-task turn whose tasks fail together — ends with nothing to run. MAX_SWITCHES and the stall rule
     * still bound the retries. Absent/false ⇒ exactly as before.
     */
    retryFailedTask?: boolean;
    /**
     * Like `retryFailedTask`, but only for a task whose failure was a SYSTEM error — the executor threw, or reported a failure
     * without a kind (the tool or model call broke). A task that exhausted its iteration budget, was rejected by the
     * completion check, or failed verification is NOT retried (that is the runaway loop / plan-rejection behaviour
     * `retryFailedTask` also covers). Each task is retried at most ONCE this way, so a persistent outage ends in the honest
     * could-not-complete reply rather than the stall escalation. Ignored when `retryFailedTask` is on (it already retries everything).
     */
    retryFailedSystemErrors?: boolean;
    /** See `ReviewerRevision`. */
    reviewerRevision?: ReviewerRevision;
    /**
     * Opt-in: feeds the memory layer's `token_budget` from real usage. `used` returns the tokens spent so far this run (the host
     * sums its model calls); it is read once per iteration, just before the context-compression node, so that node's 90% pressure
     * test is real instead of always reading 0 of 200,000. Absent ⇒ `token_budget.used` stays 0 and the pressure branch never runs.
     */
    tokenBudget?: {
        total: number;
        used: () => number;
    };
    /** Fired when a reviewer revision reopens a task, with the task id and the text `reviewerRevision` returned. A throwing handler never breaks the run. */
    onReviewerRevision?: (event: {
        taskId: string;
        note: string;
    }) => void;
    /** See `CriterionCheckable`: a success criterion this says is not checkable is skipped by the implementer lens instead of being reported as uncovered. */
    isCheckableCriterion?: CriterionCheckable;
    /** See `SemanticHypothesesHook`. Absent ⇒ hypotheses are exactly the template seeds. */
    semanticHypotheses?: SemanticHypothesesHook;
    /** See `SemanticHypothesisJudge`. Only consulted when semantic hypotheses exist. */
    semanticHypothesisJudge?: SemanticHypothesisJudge;
    /** Fired when semantic hypotheses are generated and when one is eliminated. Observability / a host's note channel; a throwing handler never breaks the run. */
    onSemanticHypothesis?: (event: SemanticHypothesisEvent) => void;
    /** See GateDecisionEvent — fired when action_gate returns BLOCK or ESCALATE, right before the run either loops or halts. */
    onGateDecision?: (event: GateDecisionEvent) => void;
    /**
     * Per-task rollback hook, keyed like toolExecutors (falls back to 'default'). Called from
     * rollbackAndReplan when a task fails verification/execution — a real rollback action
     * (e.g. restoring a `memoryState.rollback_points` snapshot) instead of the no-op the harness
     * ran before (Phase 2, layer 10 of the harness layer activation plan).
     */
    rollbackExecutors?: Record<string, () => void>;
    /**
     * Optional semantic contradiction check, layered on top of (never replacing) the always-on
     * lexical/negation-pair check detectContradictions already does for free. Called at most
     * once per iteration, only when the belief set actually grew since the last call — never
     * per-pair, and never re-sent beliefs already covered by a prior call. Receives exactly the
     * beliefs added since the last check (`newBeliefs`) and everything already known
     * (`existingBeliefs`); returns any contradictions found among newBeliefs∪existingBeliefs
     * (new-vs-existing or new-vs-new — old-vs-old was already cleared by a previous call, so
     * never needs re-checking). A caller can cheaply return `[]` without an LLM call at all for
     * a delta it judges the lexical check already covers — see personal-assistant's
     * looksLikeCodingFact for that routing.
     */
    contradictionChecker?: (newBeliefs: Array<{
        id: string;
        statement: string;
    }>, existingBeliefs: Array<{
        id: string;
        statement: string;
    }>) => Promise<ExternalContradictionInput[]>;
    /**
     * Optional semantic escalation layered on top of review-proposed-change.ts's lexical
     * `isNegation` check (fixed phrases like "not X"/"removes X"/"no longer X") — called only
     * when the lexical checks already passed, and only when there's a HIGH-confidence belief or
     * an active hypothesis prediction to actually check the proposed change against. A conflict
     * a paraphrase would let slip past the lexical check gets identical treatment (consecutive-
     * failure tracking, escalation) via applyReviewOutcome. A caller can cheaply return
     * `{ conflict: false }` without an LLM call for a change description it judges the lexical
     * check already covers.
     */
    semanticChangeReviewer?: (input: {
        changeDescription: string;
        highConfidenceBeliefs: Array<{
            id: string;
            statement: string;
        }>;
        hypothesisPredictions: string[];
    }) => Promise<{
        conflict: boolean;
        reason?: string;
    }>;
    semanticTaskCompletion?: SemanticTaskCompletion;
    semanticConstraintJudge?: SemanticConstraintJudge;
    /**
     * Opt-in: when the constraint judge finds a violation and every task is done, reopen the last completed task ONCE so the
     * host's proposer answers again, and call this with the violated constraints and a note describing them. Only the second
     * answer is judged for real — if it still violates, the run throws OutputContractError as before. Absent ⇒ a violation
     * throws straight away. A throwing handler never breaks the run.
     */
    onConstraintRevision?: (event: {
        taskId: string;
        note: string;
        violated: Array<{
            constraint: string;
            reason?: string;
        }>;
    }) => void;
    /** Called when the completion check judged a task's output did not do the task — the host can persist why (e.g. on a durable plan's task). Observability only: a throwing handler never breaks the run. */
    onTaskNotAccomplished?: (event: {
        taskId: string;
        reason: string;
    }) => void;
    /**
     * Optional: facts the caller already trusts (e.g. things the user stated in earlier turns) for
     * the semantic change reviewer to check the proposed change against, alongside the world
     * model's own >= 0.8 beliefs. Deliberately NOT written into the world model: beliefs are only
     * created after a task executes, so on a single-task turn the reviewer would otherwise see an
     * empty world model — and seeding them earlier would also pull contradiction detection ahead
     * of the first answer, blocking a turn in which the user is merely correcting a fact.
     */
    changeReviewFacts?: () => Array<{
        statement: string;
    }>;
    /**
     * Called when the semantic change reviewer finds a conflict between the task and something the
     * caller/world model holds as true. The review is ADVISORY: the task is not failed or retried
     * (a retry would see identical input and get the identical verdict), it proceeds, and the host
     * decides how to surface the reason — e.g. as a note the proposer reads and a notice to the user.
     */
    onReviewConflict?: (event: {
        taskId: string;
        reason: string;
    }) => void;
    /** A confident failure-mode match picked the next recovery strategy — see nodes/rollback-replan.ts's RollbackReplanResult.failureModeSwitch. Bookkeeping only unless the host surfaces this to the proposer. */
    onFailureModeSwitch?: (event: {
        taskId: string;
        failure_class: string;
        strategy: string;
    }) => void;
    /** With `experienceLearning` on, a LEARNED ranking (not the default order) picked the next recovery strategy — see nodes/rollback-replan.ts's RollbackReplanResult.learnedSwitch. Bookkeeping only unless the host surfaces this to the proposer. */
    onLearnedStrategySwitch?: (event: {
        taskId: string;
        failure_class: string;
        strategy: string;
    }) => void;
    /**
     * Optional semantic escalation layered on top of FailureModeLibrary's own exact-string-
     * overlap `match()` — called only when the exact match found nothing (matched_pattern is
     * still null) and there are both symptoms and library entries to check. Assigning a real
     * failure_class here (instead of leaving matched_pattern null) feeds Hypothesis generation's
     * failure_mode_library source and Reviewer Pass's failure-class priors, which otherwise stay
     * essentially inert for organically-generated observations (exact string equality against a
     * curated symptom list almost never happens by chance). A caller can cheaply return `null`
     * without an LLM call for a symptom set it judges the exact match already covers.
     */
    semanticFailureMatcher?: (symptoms: string[], libraryEntries: readonly FailureModeEntry[]) => Promise<{
        failure_class: string;
        confidence: number;
        matched_pattern: string;
    } | null>;
    /**
     * Optional semantic escalation layered on top of reviewerPass's implementer lens, which
     * otherwise only checks success-criteria coverage via a plain `.includes()` substring match —
     * called only for a criterion that substring check found no coverage for. A caller can cheaply
     * return `false` without an LLM call for a criterion it judges the substring check already
     * covers. See Phase 2/Decision 3b of the internal plan.
     */
    semanticCriterionCoverage?: SemanticCriterionCoverage;
    /**
     * Per-call gate for the host's semantic escalation hooks (`contradictionChecker`, `semanticChangeReviewer`,
     * `semanticFailureMatcher`, `semanticCriterionCoverage`). Consulted immediately before each hook runs; `false` makes that
     * call behave exactly as if the hook had not been supplied (a skipped contradiction check does not mark its beliefs covered).
     * Lets a host that decides per iteration (the adaptive layer policy) turn a layer on or off mid-turn instead of binding it
     * once when the run starts. Absent, or a throw, ⇒ the hook runs (today's behaviour).
     */
    hookEnabled?: (layer: EscalationHook) => boolean;
    /**
     * Trajectory Supervisor (the internal plan, S2) — an optional
     * async hook consulted ONLY when the run stalls (cannotMakeProgress() is true at the point a
     * failed task would be rolled back). Given the bounded stall digest, return one directive
     * (or null / anything malformed → treated as CONTINUE). The harness has no LLM of its own —
     * this stays a caller-supplied hook, like contradictionChecker / semanticFailureMatcher.
     * Absent → no supervisor (the default; equivalent to the flag being OFF).
     */
    supervisorDecider?: (digest: TrajectoryDigestData) => Promise<Partial<SupervisorDirectiveData> | null>;
    /** Fired once, right after supervisorDecider resolves, with the coerced directive that will
     * be applied. Observability only — like onGateDecision. A throwing handler is swallowed. */
    onSupervisorDirective?: (directive: SupervisorDirective) => void;
    /**
     * Trajectory Supervisor GATHER_EVIDENCE (S5) — a host-provided bounded read-only investigation.
     * Called at most INVESTIGATION_CAP_K times per run, only when the supervisor returns a
     * GATHER_EVIDENCE directive at a stall edge. The host runs its own read-only tool loop (its own
     * Budget, routed through the same tool-policy gate — no write/shell/email tools) and returns the
     * findings; the harness merges them into the WorldModel with provenance + a generation bump.
     * Absent → GATHER_EVIDENCE degrades to CONTINUE. A throw / reject degrades to CONTINUE too.
     */
    runInvestigation?: (req: InvestigationRequestData) => Promise<InvestigationFinding[]>;
    /**
     * Trajectory Supervisor ASK_USER (S3) — present iff the host can surface a structured
     * question to the user and resume the run with an answer. When set, an ASK_USER directive
     * at a stall edge throws a `supervisor_question` EscalationHalt (question + options on the
     * blocker) and this hook is called once with the question (observability — a throw is
     * swallowed). Absent → ASK_USER degrades to a plain `cannot_make_progress` escalation.
     * Per-run cap SUPERVISOR_ASK_USER_CAP_M; beyond it ASK_USER also degrades to the plain
     * escalation. The resumed run records the answer as a `user_clarification` observation.
     */
    askUser?: (question: UserQuestionData) => void;
    /**
     * Q1 of the internal plan — the global-flag control point for the
     * batched-questions ask-question primitive (ask-question.ts), already resolved by the caller
     * (e.g. personal-assistant's `askMode` AssistantConfig field, mirroring `oneLoopMode`'s exact
     * chain: env override, VITE_ build-time override, package-owned default). Absent/'disabled'
     * (DEFAULT_ASK_MODE, the default for the whole rollout window) means the supervisor's ASK_USER
     * path below degrades to the pre-Q0 single question/options blocker shape, byte-identical to
     * pre-Q1 output. `'enabled'` lets it populate the new `questions` batch instead.
     */
    askMode?: 'enabled' | 'disabled';
}
/** The host escalation hooks `hookEnabled` can gate. */
export type EscalationHook = 'semantic_contradiction' | 'change_review' | 'failure_match' | 'criterion_coverage';
export interface HarnessRunResult {
    finalResult: unknown;
    outputValidation: OutputValidationResult | null;
    stepsUsed: number;
    initResult: HarnessInitResult;
    nodeExecutionOrder: string[];
    /**
     * Constraints the semantic judge still found violated after the host's one revision (only set when the host opted into
     * `onConstraintRevision`, i.e. can show a note). Without that opt-in a violation throws OutputContractError as before.
     */
    unresolvedConstraintViolations?: Array<{
        constraint: string;
        reason?: string;
    }>;
}
export type HarnessRunOutcome = {
    status: 'complete';
    result: HarnessRunResult;
} | {
    status: 'paused';
    checkpoint: HarnessCheckpoint;
};
/**
 * F3 (the internal plan) — a turn that strands (a FAILED task, nothing
 * left runnable, nothing ever completed) must not return an empty `finalResult`: the caller
 * (personal-assistant's response-service.ts) turns a non-string `finalResult` into the draft
 * reply, and for the one-loop proposer path there is no draft — so `''` reaches the user as a
 * silent no-op. This gives them an explicit, honest "couldn't complete" line instead. Only used
 * when `ctx.finalResult` is not already a usable string.
 */
/** Opens the stranded-turn reply naming a step the completion check rejected; hosts test for it to avoid repeating that news. */
export declare const NOT_ACCOMPLISHED_REPLY_PREFIX = "I didn't complete this step \u2014 ";
export declare class HarnessRuntime {
    run(objective: string, successCriteria: string[], options?: HarnessRunOptions): Promise<HarnessRunOutcome>;
    resume(checkpoint: HarnessCheckpoint, options?: HarnessRunOptions): Promise<HarnessRunOutcome>;
}
