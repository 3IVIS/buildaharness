import type { EscalationLayer, PolicyContext, PolicyRules, RuleResult } from './layer-policy.js'

/**
 * AL10 of the adaptive layer selection plan — adaptive trigger rules v1.
 *
 * Each escalation layer's trigger is *membership in a regime*, read from `TurnSignals` / `RunState`
 * only (non-linguistic, already computed — AL-7: no new per-turn LLM call). Every rule returns
 * `null` ("no opinion ⇒ static behaviour") whenever the signal it needs is absent, so a caller that
 * supplies no signals keeps today's behaviour (AL-4/AL-9).
 *
 * Evidence status (be honest about it): AL2a has assigned no layer HELPS-IN-REGIME or a certified
 * NULL-IN-TESTED-REGIME yet (no AL1f certificates exist), so these rules encode the mechanism
 * spec's *hypothesised* regimes, not measured ones. They exist to be measured (the `adaptivePolicy`
 * arm, AL11a) and are re-derived from data by AL11c. `RULE_EVIDENCE` records this per layer; a layer
 * whose entry is `untested` and is not listed in `RULES_V1_LAYERS` keeps its static behaviour.
 *
 * AL-1: rules only ever restrict or hold at `full`; the resolver additionally clamps injection
 * detection to `full` unless a non-linguistic proof of safety holds.
 */
export type RuleEvidence = 'hypothesis' | 'helps_in_regime' | 'null_in_tested_regime'

/** Where each encoded rule's regime comes from. All hypotheses until AL11c folds in certified results. */
export const RULE_EVIDENCE: Readonly<Partial<Record<EscalationLayer, RuleEvidence>>> = {
  criterion_coverage: 'hypothesis',
  semantic_contradiction: 'hypothesis',
  failure_match: 'hypothesis',
  change_review: 'hypothesis',
  injection_detection: 'hypothesis',
  decomposition_reframe: 'hypothesis',
  model_inferred_facts: 'hypothesis',
  reviewer_adversarial: 'hypothesis',
}

const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const

function riskAtLeastMedium(ctx: PolicyContext): boolean | undefined {
  const r = ctx.signals.riskLevel
  return r in RISK_ORDER ? RISK_ORDER[r] >= RISK_ORDER.MEDIUM : undefined
}

/**
 * A routine turn, proven from signals alone: LOW risk, one task, no durable plan, no failures so
 * far, not a correction, no stated constraint, no ambiguity. Undefined signals never count as calm
 * evidence for the optional fields — but the required ones (`riskLevel`, `taskCount`) must be
 * present, which `TurnSignals` guarantees.
 */
export function isCalmTurn(ctx: PolicyContext): boolean {
  const s = ctx.signals
  if (s.riskLevel !== 'LOW' || s.taskCount > 1 || s.hasDurablePlan) return false
  if (s.pushbackOnPriorTurn === true || s.statesConstraint === true || s.userPosture === 'corrective') return false
  if (s.ambiguity === 'some' || s.ambiguity === 'high') return false
  const st = ctx.state
  if (st && (st.consecutiveFailures > 0 || st.verificationTrend === 'degrading' || st.diagnosticsTrend === 'degrading')) return false
  return true
}

const calm = (trigger: string) => (ctx: PolicyContext): RuleResult | null =>
  isCalmTurn(ctx) ? { decision: 'off', trigger, reason: 'routine LOW-risk single-task turn: no regime for this layer' } : null

export const ADAPTIVE_RULES_V1: PolicyRules = {
  // Change review: escalate when the user states a constraint or corrects the assistant (a belief
  // conflict is likely); skip on a calm turn; otherwise static.
  change_review: (ctx) => {
    const s = ctx.signals
    if (s.statesConstraint === true || s.pushbackOnPriorTurn === true) {
      return { decision: 'full', trigger: 'constraint_or_correction', reason: 'stated constraint / pushback: a belief conflict is plausible' }
    }
    return calm('calm_no_constraint')(ctx)
  },

  // Adversarial reviewer lens: only at riskLevel ≥ MEDIUM or after a soft verification failure.
  reviewer_adversarial: (ctx) => {
    const hi = riskAtLeastMedium(ctx)
    if (hi === undefined) return null
    const st = ctx.state
    const softFail = st !== undefined && (st.verificationTrend === 'degrading' || st.consecutiveFailures > 0)
    if (hi) return { decision: 'full', trigger: 'risk_medium_plus', reason: 'riskLevel ≥ MEDIUM' }
    if (softFail) return { decision: 'full', trigger: 'soft_verification_failure', reason: 'verification degrading or a tool failed this turn' }
    return { decision: 'off', trigger: 'low_risk_no_failure', reason: 'LOW risk and no verification failure' }
  },

  // Injection detection: needed only when untrusted content could reach a tool-capable next step.
  // The resolver clamps any skip back to `full` without a non-linguistic proof (AL-1).
  injection_detection: (ctx) => {
    const untrusted = ctx.state?.untrustedContentInContext
    const tools = ctx.signals.consequentialTools
    if (untrusted === undefined || tools === undefined) return null
    if (untrusted && tools.size > 0) return { decision: 'full', trigger: 'untrusted_reaches_tools', reason: 'untrusted content and a tool-capable next step' }
    return { decision: 'off', trigger: !untrusted ? 'no_untrusted_content' : 'no_tool_capable_step', reason: 'non-linguistic proof: nothing untrusted can reach a consequential tool' }
  },

  // Decomposition reframe: only when the turn needs a multi-step plan.
  decomposition_reframe: (ctx) => {
    const s = ctx.signals
    if (s.taskCount > 1 || s.hasDurablePlan) return { decision: 'full', trigger: 'needs_multi_step_plan', reason: 'multi-task or durable-plan turn' }
    return { decision: 'off', trigger: 'single_step', reason: 'single-task turn needs no reframe' }
  },

  // Model-inferred facts: worth the call on a multi-turn session or a directive/exploratory turn
  // that is not routine; skipped on a calm informational one.
  model_inferred_facts: (ctx) => {
    const s = ctx.signals
    if ((ctx.state?.turnDepth ?? 0) > 0) return { decision: 'full', trigger: 'multi_turn_session', reason: 'turnDepth > 0' }
    if (isCalmTurn(ctx) && s.userPosture === 'informational') return { decision: 'off', trigger: 'calm_informational', reason: 'routine informational turn' }
    return null
  },

  // Everything else is off for LOW-risk single-task work and static otherwise; criterion coverage
  // has a cheap (substring) form to fall back to.
  semantic_contradiction: calm('calm_low_risk'),
  failure_match: calm('calm_low_risk'),
  criterion_coverage: (ctx) =>
    isCalmTurn(ctx) ? { decision: 'cheap', trigger: 'calm_low_risk', reason: 'routine turn: substring coverage check only' } : null,
}
