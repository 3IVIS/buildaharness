import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { DecomposedTaskSpec } from './decomposition-classifier.js';
/**
 * 'UNKNOWN' is never produced by a successful classification (TURN_INTENT_SCHEMA's riskLevel enum
 * only ever allows LOW/MEDIUM/HIGH from the model) — it exists solely as failSafeClassification's
 * fail-safe value, so callers can route a classifier failure to their most conservative branch
 * instead of silently treating it as LOW risk. See failSafeClassification's doc comment.
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
/** Only meaningful for `source: 'model_inferred'` facts — see fact-extraction.ts's `UserFact`. */
export type FactConfidence = 'high' | 'medium' | 'low';
/**
 * Fixed enum, not free text, so the pending-confirmation queue (Phase 3 of
 * the internal plan) can group entries stably
 * instead of drifting between synonyms ("job"/"occupation"/"work") for the same underlying topic.
 */
export type FactCategory = 'identity' | 'health' | 'preference' | 'location' | 'occupation' | 'relationships' | 'project' | 'other';
export interface StatedFact {
    text: string;
    durable: boolean;
    confidence: FactConfidence;
    category: FactCategory;
    /** M1: stable snake_case key when the fact names a single-valued attribute; absent otherwise (fail-open: no key = accumulate as before). */
    key?: string;
    /** M2 judgements, returned by the same classifier call. Missing = the write gate fails closed (not promoted). */
    containsSecret?: boolean;
    /** M2: the fact text with any secret removed; empty when the claim is itself the secret. */
    redactedText?: string;
    looksLikeInstruction?: boolean;
    /** M2: the user's own supporting words. */
    evidence?: string;
}
/** AL5a user-input signals. 'unknown' is only ever produced by failSafeClassification, never by the model (same convention as RiskLevel's 'UNKNOWN'). */
export type TurnAmbiguityLevel = 'none' | 'some' | 'high' | 'unknown';
export type TurnPosture = 'informational' | 'directive' | 'exploratory' | 'corrective' | 'unknown';
export interface TurnIntentContext {
    /** Whether an active durable plan exists for this session — gates whether the abandon
     *  judgment means anything and whether plan-template matching should even be attempted
     *  (mirrors assistant.ts's own `if (activePlan) { ... } else { match a template } ` split). */
    hasActivePlan: boolean;
    /** Constraints the user stated earlier this session (numbered 1..N in the prompt) — lets the message lift one. */
    standingConstraints?: string[];
    /** Keyed facts already in durable memory. Shown to the classifier so a new value of the same attribute reuses the stored key (supersession matches keys by equality, so a re-worded key would miss). */
    knownFactKeys?: {
        key: string;
        text: string;
    }[];
}
export interface TurnIntentClassification {
    riskLevel: RiskLevel;
    riskReason: string;
    /** Computed here from riskLevel/isBulkReminderRequest for trace/display purposes and any
     *  caller that only wants the raw classifier verdict. Phase D3: no gating call site reads this
     *  field directly anymore — turn-interpreter.ts's approval gate and assistant.ts's
     *  execution-mode classification both recompute the decision from riskLevel/isBulkReminderRequest
     *  via turn-policy.ts's evaluateTurnPolicy() instead, so a future bug here can't silently change
     *  what those care about (INV-14). */
    requiresApproval: boolean;
    /** Only meaningful when riskLevel === 'LOW' — same precondition classifyTriviality had. */
    isTrivial: boolean;
    decomposedTasks: DecomposedTaskSpec[] | null;
    /** True when the request asks to create a calendar/reminder entry (regardless of how many). */
    isReminderRequest: boolean;
    /** True when isReminderRequest is true AND the request looks like it may create more than one
     *  reminder in a single turn — same signal risk-classifier.ts's BULK_REMINDER_REASON gated on,
     *  folded into requiresApproval the same way. Always false when isReminderRequest is false. */
    isBulkReminderRequest: boolean;
    /** Only meaningful when context.hasActivePlan is true. */
    isAbandonRequest: boolean;
    /**
     * True only when a plan is active AND the message merely asks about it or discusses it (where it
     * stands, what a step is, what is left, why something failed) — no new work, no go-ahead to
     * continue. Such a turn is answered from the plan's state instead of re-driving the plan's tasks.
     * Additive: a missing/malformed value is false, which is today's behaviour (the active plan drives
     * every non-trivial turn).
     */
    isPlanQuestion?: boolean;
    /**
     * Part of the plan judgment: with a plan active, the message tells the assistant to continue it (a go-ahead, "retry",
     * "run the next step", details for a step that failed) as opposed to being about something else entirely. `undefined`
     * when no plan is active or the model omitted/garbled it — callers then treat the message as continuing the plan, which
     * is today's behaviour. Only an explicit `false` lets a stuck plan be set aside (see plan-question.ts).
     */
    continuesPlan?: boolean;
    /**
     * The 15th judgment: the message asks why something happened or which of several things is true, and the message
     * itself gives no way to tell the possible explanations apart. Optional and fail-safe false — a classifier failure
     * never claims a request is underdetermined. Only read by the semantic-hypotheses hook (AUDIT_SEMANTIC_HYPOTHESES).
     */
    isUnderdetermined?: boolean;
    /** One of listTemplateNames()'s names, or null. Only ever set when context.hasActivePlan is false. */
    matchedPlanTemplate: string | null;
    /**
     * P3 of the internal plan — the generalized, domain-general
     * counterpart to matchedPlanTemplate: true when the request warrants a durable, tracked,
     * user-approved plan even though it doesn't match one of the 7 named template kinds (e.g. a
     * code-implementation request spanning several files/tests). Always false when
     * matchedPlanTemplate is already set (a template match is itself one flavor of "needs a
     * plan" — callers should treat `matchedPlanTemplate !== null || needsMultiStepPlan` as the
     * combined trigger) and always false when context.hasActivePlan is true, same gating
     * matchedPlanTemplate already uses.
     */
    needsMultiStepPlan: boolean;
    /**
     * Every durable/session fact the message states about the user (name, preference,
     * health/dietary, current location/job, ...) — the LLM-backed primary extraction path this
     * plan builds (the internal plan Phase 1),
     * superseding the old single-fact `statesDurableFact` fallback so a turn stating more than one
     * fact ("I'm Priya, I'm vegetarian, and I live in Austin") isn't truncated to one. `confidence`
     * is anchored to an observable criterion, not a bare self-report: `high` = stated directly and
     * unhedged in first person; `medium` = stated about the user but hedged, indirect, or inferred
     * from context; `low` = a weak inference, or primarily about a third party and only tangentially
     * about the user. `durable`'s contract is unchanged from the old field: true only for
     * identity/safety-relevant facts meant to persist indefinitely, false for something expected to
     * change. Empty array (not null) when nothing was stated, including on classifier failure — see
     * failSafeClassification.
     */
    statesDurableFacts: StatedFact[];
    /**
     * AL5a (adaptive layer selection plan) — user-input signals for the layer policy, riding this
     * same single call (AL-7). All optional so a hand-built classification (tests, fixtures) needs
     * no change; nothing reads them yet, so ignoring them is behaviour-neutral (AL-2).
     * `needsGrounding`: the answer depends on facts that should be checked against a source or tool
     * rather than recalled. `ambiguity`: how under-specified the request is. `userPosture`: what the
     * user is doing (asking, directing, exploring, correcting). `pushbackOnPriorTurn`: the user
     * disputes or corrects the assistant's previous reply. `statesConstraint`: the message sets a
     * rule/limit that should govern later turns ("never...", "only...", "from now on...").
     */
    needsGrounding?: boolean;
    ambiguity?: TurnAmbiguityLevel;
    userPosture?: TurnPosture;
    pushbackOnPriorTurn?: boolean;
    statesConstraint?: boolean;
    /**
     * The constraint(s) the message sets, each as a short standalone sentence a reply can be checked against ("Do not use
     * tabs", "Keep it under 100 words"). Only set alongside `statesConstraint` — empty otherwise, and on a classifier
     * failure. Capped at MAX_STATED_CONSTRAINTS.
     */
    statedConstraints?: string[];
    /**
     * 1-based positions in `statedConstraints` of the rules meant to keep governing LATER turns ("from now on", "always",
     * "never ..."), as opposed to one that only shapes this answer ("five lines at most"). Only those are persisted for the
     * session; every stated constraint is still checked this turn. `undefined` when the model omitted the field — callers
     * then treat every stated constraint as lasting, as before the field existed.
     */
    lastingConstraints?: number[];
    /**
     * 1-based positions, in the standing-constraint list the prompt showed, of the constraints this message lifts ("tabs are
     * fine now", "ignore the word limit"). Empty when none were shown or none lifted, and on a classifier failure.
     */
    liftedConstraints?: number[];
}
/** The most constraints one message can hand the harness — a message with more is not a rule list but a spec. */
export declare const MAX_STATED_CONSTRAINTS = 4;
/**
 * The classification an automatic audit retry runs under: the one of the turn it corrects. The retry's message is the system's own
 * nudge, not something the user asked, so classifying it is a wasted model call that can stall for a minute or fail (benchmark
 * scenario 10: the nudge's classification failed, the UNKNOWN risk level then made every tool call of the retry require approval,
 * and the turn came back as an escalation instead of a correction). Only the risk and grounding signals carry over; whatever the
 * original message said about plans, tasks, facts or constraints belongs to that message and is cleared.
 */
export declare function classificationForAuditRetry(prior: TurnIntentClassification): TurnIntentClassification;
export declare function classifyTurnIntent(message: string, llmClient: ILLMClient, context: TurnIntentContext, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<TurnIntentClassification>;
