import type { RunState, TurnSignals } from './turn-signals.js'

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

export type Decision = 'off' | 'cheap' | 'full'

/** Ordered least → most cost/coverage; used for restriction comparisons. */
export const DECISION_ORDER: Readonly<Record<Decision, number>> = { off: 0, cheap: 1, full: 2 }

export const FLOOR_LAYERS = [
  'control_state', 'approval_staging', 'tool_policy', 'diagnostics', 'hypothesis', 'mandatory_verification',
] as const
export const ESCALATION_LAYERS = [
  'semantic_contradiction', 'failure_match', 'criterion_coverage', 'change_review', 'injection_detection',
  'decomposition_reframe', 'model_inferred_facts', 'reviewer_adversarial',
] as const
export const EVENT_LAYERS = ['supervisor'] as const
export const PRESENTATION_LAYERS = ['next_step_options', 'goal_graph', 'steering'] as const

export type FloorLayer = (typeof FLOOR_LAYERS)[number]
export type EscalationLayer = (typeof ESCALATION_LAYERS)[number]
export type EventLayer = (typeof EVENT_LAYERS)[number]
export type PresentationLayer = (typeof PRESENTATION_LAYERS)[number]
export type Layer = FloorLayer | EscalationLayer | EventLayer | PresentationLayer
export type LayerClass = 'floor' | 'escalation' | 'event' | 'presentation'

/** The one table declaring every layer's class. */
export const LAYER_CLASS: Readonly<Record<Layer, LayerClass>> = {
  control_state: 'floor',
  approval_staging: 'floor',
  tool_policy: 'floor',
  diagnostics: 'floor',
  hypothesis: 'floor',
  mandatory_verification: 'floor',
  semantic_contradiction: 'escalation',
  failure_match: 'escalation',
  criterion_coverage: 'escalation',
  change_review: 'escalation',
  injection_detection: 'escalation',
  decomposition_reframe: 'escalation',
  model_inferred_facts: 'escalation',
  reviewer_adversarial: 'escalation',
  supervisor: 'event',
  next_step_options: 'presentation',
  goal_graph: 'presentation',
  steering: 'presentation',
}

/**
 * Whether an escalation has a non-linguistic `cheap` form (numeric/structural/state checks, no LLM).
 * A layer without one has `cheap ≡ off`, and a `cheap` decision is normalised to `off`.
 */
export const HAS_CHEAP_FORM: Readonly<Record<EscalationLayer, boolean>> = {
  semantic_contradiction: false,
  failure_match: false,
  criterion_coverage: true,
  change_review: false,
  injection_detection: false,
  decomposition_reframe: false,
  model_inferred_facts: false,
  reviewer_adversarial: false,
}

export interface LayerDecision {
  decision: Decision
  trigger: string
  reason: string
}

/**
 * Per-turn LLM-call budget view; null (or Infinity) = unlimited. `priority` is the order in which
 * escalations draw on it (AL9a); unlisted escalations follow in `DEFAULT_LAYER_PRIORITY` order.
 */
export interface PolicyBudget {
  remainingCalls: number | null
  priority?: readonly EscalationLayer[]
}

/**
 * Deterministic default draw order (AL2a's measured priority list is still empty, so this is the
 * fallback): the security layer first so its clamped `full` is always accounted for, then the
 * layers that guard correctness of the answer, then the more speculative ones.
 */
export const DEFAULT_LAYER_PRIORITY: readonly EscalationLayer[] = [
  'injection_detection', 'semantic_contradiction', 'criterion_coverage', 'reviewer_adversarial',
  'change_review', 'failure_match', 'model_inferred_facts', 'decomposition_reframe',
]

/** LLM calls a layer draws when it runs at `full`. `cheap`/`off` draw nothing. */
export const LAYER_CALL_COST: Readonly<Record<EscalationLayer, number>> = {
  semantic_contradiction: 1,
  failure_match: 1,
  criterion_coverage: 1,
  change_review: 1,
  injection_detection: 1,
  decomposition_reframe: 1,
  model_inferred_facts: 1,
  reviewer_adversarial: 1,
}

/** `priority` first (deduplicated, unknown names ignored), then the remaining layers in default order. */
export function orderedPriority(priority?: readonly EscalationLayer[]): EscalationLayer[] {
  const seen = new Set<EscalationLayer>()
  const out: EscalationLayer[] = []
  for (const l of [...(priority ?? []), ...DEFAULT_LAYER_PRIORITY]) {
    if (!(ESCALATION_LAYERS as readonly string[]).includes(l) || seen.has(l)) continue
    seen.add(l)
    out.push(l)
  }
  return out
}

export interface PolicyContext {
  signals: TurnSignals
  state: RunState | undefined
  budget: PolicyBudget
}

export type RuleResult = { decision: Decision; trigger: string; reason?: string }
/** Adaptive rules. Keyed by escalation layers ONLY — floor layers are undecidable by construction. */
export type PolicyRules = { [L in EscalationLayer]?: (ctx: PolicyContext) => RuleResult | null }

export type LayerPolicy = Record<Layer, LayerDecision>

export const STATIC_TRIGGER = 'static'

/** True when a non-linguistic condition proves injection detection is safe to skip (AL-1). */
export function injectionSkipProvenSafe(ctx: PolicyContext): boolean {
  const noUntrusted = ctx.state !== undefined && ctx.state.untrustedContentInContext === false
  const noToolCapableStep = ctx.signals.consequentialTools !== undefined && ctx.signals.consequentialTools.size === 0
  return noUntrusted || noToolCapableStep
}

/** Today's behaviour: every layer at `full`. */
export function staticLayerPolicy(): LayerPolicy {
  const out = {} as LayerPolicy
  for (const layer of Object.keys(LAYER_CLASS) as Layer[]) {
    out[layer] = { decision: 'full', trigger: STATIC_TRIGGER, reason: 'static policy: today\'s behaviour' }
  }
  return out
}

function isDecision(v: unknown): v is Decision {
  return v === 'off' || v === 'cheap' || v === 'full'
}

function limitedCalls(b: PolicyBudget): number | null {
  const n = b.remainingCalls
  return n === null || typeof n !== 'number' || Number.isNaN(n) || n === Infinity ? null : Math.max(0, n)
}

/**
 * Resolves every layer's decision. With no `rules` and no call limit the result is the static
 * policy. AL9a: a finite call budget is spent by escalations in priority order (`budget.priority`,
 * then `DEFAULT_LAYER_PRIORITY`); a layer that would run at `full` but cannot afford its
 * `LAYER_CALL_COST` degrades to its cheap form with trigger `budget_exhausted` (AL-4: the only
 * sanctioned degradation, named in the trace). Floor layers are never touched. The injection
 * security clamp is applied after degradation and still draws on the budget. Never throws; any
 * failure returns static.
 */
export function resolveLayerPolicy(
  signals: TurnSignals,
  state: RunState | undefined,
  budget: PolicyBudget,
  rules: PolicyRules = {},
): LayerPolicy {
  try {
    const ctx: PolicyContext = { signals, state, budget }
    const out = staticLayerPolicy()
    const proposedByLayer = new Map<EscalationLayer, LayerDecision | null>()
    for (const layer of ESCALATION_LAYERS) {
      const rule = rules[layer]
      const proposed = rule ? rule(ctx) : null
      if (proposed) {
        if (!isDecision(proposed.decision) || typeof proposed.trigger !== 'string') return staticLayerPolicy()
        proposedByLayer.set(layer, { decision: proposed.decision, trigger: proposed.trigger, reason: proposed.reason ?? proposed.trigger })
      } else {
        proposedByLayer.set(layer, null)
      }
    }
    let remaining = limitedCalls(budget)
    for (const layer of orderedPriority(budget.priority)) {
      let next = proposedByLayer.get(layer) ?? null
      const wantsFull = next === null || next.decision === 'full'
      const cost = LAYER_CALL_COST[layer]
      if (remaining !== null && wantsFull && remaining < cost) {
        next = { decision: 'cheap', trigger: 'budget_exhausted', reason: 'per-turn LLM-call budget exhausted' }
      }
      if (!next) {
        if (remaining !== null) remaining = Math.max(0, remaining - cost)
        continue
      }
      if (next.decision === 'cheap' && !HAS_CHEAP_FORM[layer]) next = { ...next, decision: 'off' }
      if (next.decision !== 'full' && layer === 'injection_detection' && !injectionSkipProvenSafe(ctx)) {
        next = { decision: 'full', trigger: 'security_floor', reason: 'AL-1: injection detection needs a non-linguistic proof to skip' }
      }
      if (remaining !== null && next.decision === 'full') remaining = Math.max(0, remaining - cost)
      out[layer] = next
    }
    return out
  } catch {
    return staticLayerPolicy()
  }
}

/**
 * AL8b: the ad hoc booleans that used to live inline in `harness-runtime.ts` as named policy gates.
 * Each is a *display / cost* gate, never a floor computation (hypothesis generation, evidence
 * baseline and world-model updates always run). Under the static policy the outcome is exactly
 * today's boolean (AL-2); an adaptive policy may only change it through a non-static trigger.
 */
export const AD_HOC_GATES = ['hypothesis_display', 'evidence_escalation', 'belief_trail', 'reviewer_adversarial'] as const
export type AdHocGate = (typeof AD_HOC_GATES)[number]

export interface GateOutcome {
  on: boolean
  /** Set only when the policy (not the static baseline) decided; drives "escalated/skipped-with-reason" rendering. */
  decision?: Decision
  trigger?: string
}

/**
 * `staticOutcome` is today's boolean. A missing policy, a missing entry or a `static` trigger all
 * return it unchanged. A non-static `full` forces the gate on (escalate-on-trigger), `off` forces
 * it off, `cheap` (no separate form for a boolean gate) keeps the static outcome.
 */
export function resolveGate(policy: LayerPolicy | undefined, gate: AdHocGate, staticOutcome: boolean): GateOutcome {
  try {
    const d = (policy as Partial<Record<string, LayerDecision>> | undefined)?.[gate]
    if (!d || d.trigger === STATIC_TRIGGER || !isDecision(d.decision)) return { on: staticOutcome }
    if (d.decision === 'cheap') return { on: staticOutcome, decision: d.decision, trigger: d.trigger }
    return { on: d.decision === 'full', decision: d.decision, trigger: d.trigger }
  } catch {
    return { on: staticOutcome }
  }
}

/**
 * Re-evaluates the policy at an iteration boundary with fresh state (after diagnostics/verify), so
 * an escalate-on-evidence rule can fire within a turn. Never throws; on error returns `prev`.
 */
export function reevaluateLayerPolicy(
  prev: LayerPolicy | undefined,
  signals: TurnSignals,
  state: RunState | undefined,
  budget: PolicyBudget,
  rules: PolicyRules,
): LayerPolicy | undefined {
  if (prev === undefined) return prev
  try {
    return resolveLayerPolicy(signals, state, budget, rules)
  } catch {
    return prev
  }
}
