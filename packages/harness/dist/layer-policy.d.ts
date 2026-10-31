import { RunState, TurnSignals } from './turn-signals.js';
/**
 * AL7a of the adaptive layer selection plan. `resolveLayerPolicy` is a pure function
 * `(TurnSignals, RunState, Budget) → Record<Layer, LayerDecision>`. Nothing reads it yet (AL7b/AL8
 * wire it), so this file changes no runtime behaviour (AL-2).
 *
 * Invariants encoded here:
 *  - AL-1: the policy only ever *restricts* — the static baseline is the maximum, and floor layers
 *    are structurally un-decidable (`PolicyRules` is keyed by `EscalationLayer` alone, so a rule for
 *    a floor layer is a type error). Injection detection may drop below `full` only on a
 *    non-linguistic proof of safety (no untrusted content in context, or no tool-capable next step).
 *  - AL-4: any rule throwing, or returning a non-Decision, resolves the whole policy to static.
 *  - AL-5: every layer carries `{decision, trigger, reason}`.
 */
export type Decision = 'off' | 'cheap' | 'full';
/** Ordered least → most cost/coverage; used for restriction comparisons. */
export declare const DECISION_ORDER: Readonly<Record<Decision, number>>;
export declare const FLOOR_LAYERS: readonly ["control_state", "approval_staging", "tool_policy", "diagnostics", "hypothesis", "mandatory_verification"];
export declare const ESCALATION_LAYERS: readonly ["semantic_contradiction", "failure_match", "criterion_coverage", "change_review", "injection_detection", "decomposition_reframe", "model_inferred_facts", "reviewer_adversarial"];
/**
 * Layers that ship OFF and exist only when the host turned them on (an `AUDIT_*` flag). Unlike every
 * other class their static baseline is `off`, not `full`: the policy is restrict-only (AL-1), so it can
 * never switch one on — it can only degrade an enabled one (no `cheap` form, so to `off`) when the
 * per-turn call budget cannot pay for it. The host says which are enabled (`enabledOptIn`).
 */
export declare const OPT_IN_LAYERS: readonly ["source_reliability", "semantic_hypotheses", "reviewer_revision", "experience_learning", "semantic_compaction", "memory_reviewer"];
export declare const EVENT_LAYERS: readonly ["supervisor"];
export declare const PRESENTATION_LAYERS: readonly ["next_step_options", "goal_graph", "steering"];
export type FloorLayer = (typeof FLOOR_LAYERS)[number];
export type EscalationLayer = (typeof ESCALATION_LAYERS)[number];
export type OptInLayer = (typeof OPT_IN_LAYERS)[number];
export type EventLayer = (typeof EVENT_LAYERS)[number];
export type PresentationLayer = (typeof PRESENTATION_LAYERS)[number];
export type Layer = FloorLayer | EscalationLayer | OptInLayer | EventLayer | PresentationLayer;
export type LayerClass = 'floor' | 'escalation' | 'opt_in' | 'event' | 'presentation';
/** The one table declaring every layer's class. */
export declare const LAYER_CLASS: Readonly<Record<Layer, LayerClass>>;
/**
 * Whether an escalation has a non-linguistic `cheap` form (numeric/structural/state checks, no LLM).
 * A layer without one has `cheap ≡ off`, and a `cheap` decision is normalised to `off`.
 */
export declare const HAS_CHEAP_FORM: Readonly<Record<EscalationLayer, boolean>>;
/** How well each opt-in layer is known to work. None has a certified benefit; this is the record, not a promise. */
export type OptInEvidence = 'mechanism_verified' | 'suggestive' | 'untested_with_real_model';
export declare const OPT_IN_EVIDENCE: Readonly<Record<OptInLayer, OptInEvidence>>;
/** The operator flag that turns each opt-in layer on (read once, in the host). */
export declare const OPT_IN_FLAG: Readonly<Record<OptInLayer, string>>;
/** Worst-case LLM calls an enabled opt-in layer draws in one turn (`experience_learning` makes none). */
export declare const OPT_IN_CALL_COST: Readonly<Record<OptInLayer, number>>;
export declare const OPT_IN_DISABLED_TRIGGER = "opt_in_disabled";
export interface LayerDecision {
    decision: Decision;
    trigger: string;
    reason: string;
}
/**
 * Per-turn LLM-call budget view; null (or Infinity) = unlimited. `priority` is the order in which
 * escalations draw on it (AL9a); unlisted escalations follow in `DEFAULT_LAYER_PRIORITY` order.
 */
export interface PolicyBudget {
    remainingCalls: number | null;
    priority?: readonly EscalationLayer[];
}
/**
 * Deterministic default draw order (AL2a's measured priority list is still empty, so this is the
 * fallback): the security layer first so its clamped `full` is always accounted for, then the
 * layers that guard correctness of the answer, then the more speculative ones.
 */
export declare const DEFAULT_LAYER_PRIORITY: readonly EscalationLayer[];
/** LLM calls a layer draws when it runs at `full`. `cheap`/`off` draw nothing. */
export declare const LAYER_CALL_COST: Readonly<Record<EscalationLayer, number>>;
/** `priority` first (deduplicated, unknown names ignored), then the remaining layers in default order. */
export declare function orderedPriority(priority?: readonly EscalationLayer[]): EscalationLayer[];
export interface PolicyContext {
    signals: TurnSignals;
    state: RunState | undefined;
    budget: PolicyBudget;
}
export type RuleResult = {
    decision: Decision;
    trigger: string;
    reason?: string;
};
/** Adaptive rules. Keyed by escalation layers ONLY — floor layers are undecidable by construction. */
export type PolicyRules = {
    [L in EscalationLayer]?: (ctx: PolicyContext) => RuleResult | null;
};
export type LayerPolicy = Record<Layer, LayerDecision>;
export declare const STATIC_TRIGGER = "static";
/** True when a non-linguistic condition proves injection detection is safe to skip (AL-1). */
export declare function injectionSkipProvenSafe(ctx: PolicyContext): boolean;
/** Today's behaviour: every layer at `full`, except an opt-in layer the host has not enabled (`off`, trigger `opt_in_disabled`). */
export declare function staticLayerPolicy(enabledOptIn?: Iterable<OptInLayer>): LayerPolicy;
/**
 * Resolves every layer's decision. With no `rules` and no call limit the result is the static
 * policy. AL9a: a finite call budget is spent by escalations in priority order (`budget.priority`,
 * then `DEFAULT_LAYER_PRIORITY`); a layer that would run at `full` but cannot afford its
 * `LAYER_CALL_COST` degrades to its cheap form with trigger `budget_exhausted` (AL-4: the only
 * sanctioned degradation, named in the trace). Floor layers are never touched. The injection
 * security clamp is applied after degradation and still draws on the budget. Never throws; any
 * failure returns static.
 */
export declare function resolveLayerPolicy(signals: TurnSignals, state: RunState | undefined, budget: PolicyBudget, rules?: PolicyRules, enabledOptIn?: Iterable<OptInLayer>): LayerPolicy;
/**
 * AL8b: the ad hoc booleans that used to live inline in `harness-runtime.ts` as named policy gates.
 * Each is a *display / cost* gate, never a floor computation (hypothesis generation, evidence
 * baseline and world-model updates always run). Under the static policy the outcome is exactly
 * today's boolean (AL-2); an adaptive policy may only change it through a non-static trigger.
 */
export declare const AD_HOC_GATES: readonly ["hypothesis_display", "evidence_escalation", "belief_trail", "reviewer_adversarial"];
export type AdHocGate = (typeof AD_HOC_GATES)[number];
export interface GateOutcome {
    on: boolean;
    /** Set only when the policy (not the static baseline) decided; drives "escalated/skipped-with-reason" rendering. */
    decision?: Decision;
    trigger?: string;
}
/**
 * `staticOutcome` is today's boolean. A missing policy, a missing entry or a `static` trigger all
 * return it unchanged. A non-static `full` forces the gate on (escalate-on-trigger), `off` forces
 * it off, `cheap` (no separate form for a boolean gate) keeps the static outcome.
 */
export declare function resolveGate(policy: LayerPolicy | undefined, gate: AdHocGate, staticOutcome: boolean): GateOutcome;
/**
 * Re-evaluates the policy at an iteration boundary with fresh state (after diagnostics/verify), so
 * an escalate-on-evidence rule can fire within a turn. Never throws; on error returns `prev`.
 */
export declare function reevaluateLayerPolicy(prev: LayerPolicy | undefined, signals: TurnSignals, state: RunState | undefined, budget: PolicyBudget, rules: PolicyRules): LayerPolicy | undefined;
