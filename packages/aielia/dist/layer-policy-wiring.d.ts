import { LayerPolicy, LayerPolicyMode, OptInLayer, PolicyBudget, PolicyRules, RunState, TurnSignals, TurnTier } from '@buildaharness/harness';
import { TurnIntentClassification } from './turn-intent-classifier.js';
/**
 * The opt-in layers (default OFF, one `AUDIT_*` flag each) the operator has switched on. Each flag is still read
 * where the layer runs; this only tells the policy which ones exist this turn so its record is true.
 */
export declare function enabledOptInLayers(env?: Record<string, string | undefined>): OptInLayer[];
/**
 * Whether an opt-in layer runs this turn. Restrict-only (AL-1): the layer's own `AUDIT_*` flag must be on (`flagOn`) AND the
 * plan must not have switched it `off` (`budget_exhausted`) — a plan can never turn a disabled layer on. Only an `adaptive`
 * plan exists (`resolveOptInPlan`); with none, or a decision the plan lacks, or a plan that throws, the flag alone decides,
 * i.e. today's behaviour.
 */
export declare function optInLayerEnabled(layer: OptInLayer, flagOn: boolean, plan: EscalationPlan | undefined): boolean;
/**
 * The plan the opt-in layers are gated by, resolved once per turn right after classification — before the tool-less draft
 * and the harness run, which is where the earliest opt-in call sits. Their decisions depend only on which are enabled and on
 * the per-turn call budget (risk and posture), none of which needs the task graph, so the minimal signals here give the same
 * answer the harness's own plan would. `undefined` unless `adaptive`: static and shadow execute today's behaviour.
 */
export declare function resolveOptInPlan(mode: LayerPolicyMode, classification: TurnIntentClassification): EscalationPlan | undefined;
export declare const SEMANTIC_ESCALATIONS: readonly ["semantic_contradiction", "failure_match", "criterion_coverage", "change_review", "model_inferred_facts"];
export type SemanticEscalation = (typeof SEMANTIC_ESCALATIONS)[number];
export declare const ESCALATION_ENV: Readonly<Record<SemanticEscalation, string>>;
/** `true`/`false` when the operator set the env var explicitly; `undefined` when unset/empty. */
export declare function explicitEnvOverride(varName: string, env?: Record<string, string | undefined>): boolean | undefined;
export interface EscalationPlan {
    mode: LayerPolicyMode;
    tier: TurnTier;
    /** The policy that executes (static under static/shadow). */
    policy: LayerPolicy;
    /** Under shadow only: what adaptive would have decided. Recorded, never acted on. */
    shadow?: {
        policy: LayerPolicy;
        tier: TurnTier;
    };
}
/** AL9a: the per-turn LLM-call budget view for a turn's signals (risk- and posture-scaled). Static mode ignores it. */
export declare function turnPolicyBudget(signals: TurnSignals): PolicyBudget;
/** Resolves the executed policy for a turn. Never throws; any failure ⇒ today's static behaviour. */
export declare function resolveEscalationPlan(mode: LayerPolicyMode, signals: TurnSignals, state: RunState | undefined, rules?: PolicyRules, budget?: PolicyBudget): EscalationPlan;
/**
 * Whether `layer`'s semantic (LLM) form runs this turn. `cheap` is a non-linguistic form, so for
 * these layers only `full` runs the LLM hook. An explicit env override wins; a missing/broken plan
 * keeps today's behaviour (ON).
 */
export declare function escalationEnabled(layer: SemanticEscalation, plan: EscalationPlan | undefined, env?: Record<string, string | undefined>): boolean;
/**
 * Whether a semantic escalation hook is supplied to the harness at all: unless the operator's explicit `AUDIT_*` value switches
 * it off. The plan no longer decides this — it is consulted per call (`HarnessRunOptions.hookEnabled`), so a hook the opening
 * plan would have left off can still run once mid-turn evidence changes the plan. With a static plan the result is exactly
 * what `escalationEnabled` gave (the plan says `full`, so only the env override mattered).
 */
export declare function escalationHookWired(layer: SemanticEscalation, env?: Record<string, string | undefined>): boolean;
/** The policy the harness runtime's ad hoc gates read: only an executed `adaptive` policy differs from today's. */
export declare function harnessGatePolicy(plan: EscalationPlan | undefined): LayerPolicy | undefined;
/**
 * Decomposition reframe (`reframeTaskDescriptionWithLLM`). Precedence: explicit `AUDIT_DECOMPOSITION`
 * env > the policy's decision > today's ON. `cheap` has no LLM-free form ⇒ off (only `full` reframes).
 */
export declare function decompositionReframeEnabled(plan: EscalationPlan | undefined, env?: Record<string, string | undefined>): boolean;
/**
 * LLM injection detection on fetched content (AL-1 security rule). Skippable ONLY on a
 * non-linguistic proof of safety: no untrusted content in context, or no tool-capable next step.
 * Anything the policy says short of `full` without such a proof is overridden back to ON — the
 * check never trusts a message/LLM-derived signal, and the wiring re-verifies what
 * `resolveLayerPolicy` already clamps so a hand-built plan cannot bypass it.
 */
export declare function injectionDetectionEnabled(plan: EscalationPlan | undefined, proof: {
    untrustedContentInContext: boolean;
    toolCapableNextStep: boolean;
}): boolean;
/** One-line reason a layer's decision is worth surfacing (escalated / skipped-with-reason), or `undefined` when routine. */
export declare function decisionNote(event: {
    decision?: string;
    trigger?: string;
}): string | undefined;
