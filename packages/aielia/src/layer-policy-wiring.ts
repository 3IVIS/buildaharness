/**
 * AL8a of plans/adaptive_layer_selection_plan.html — routes the five semantic escalations
 * (contradiction, failure match, criterion coverage, change review, model-inferred facts) through
 * `resolveLayerPolicy`, and adopts `resolveTurnTier` so a T1 LITE turn skips them.
 *
 * Precedence, most to least authoritative:
 *  1. an explicit `AUDIT_*` env value (an operator choice is never silently changed);
 *  2. the policy's decision (adaptive mode only; static/shadow execute today's behaviour);
 *  3. today's default (ON).
 * A policy error at any point falls back to (3).
 */
import {
  resolveModedLayerPolicy,
  computeTurnCallBudget,
  ADAPTIVE_RULES_V1,
  toPolicyBudget,
  staticLayerPolicy,
  OPT_IN_LAYERS,
  type EscalationLayer,
  type LayerDecision,
  type LayerPolicy,
  type LayerPolicyMode,
  type OptInLayer,
  type PolicyBudget,
  type PolicyRules,
  type RunState,
  type TurnSignals,
  type TurnTier,
} from '@buildaharness/harness'

import { experienceLearningEnabled } from './harness-bridge.js'
import { semanticCompactionEnabled } from './semantic-compaction.js'
import { reviewerRevisionEnabled } from './reviewer-revision.js'
import { semanticHypothesesEnabled } from './semantic-hypotheses.js'
import { sourceReliabilityEnabled } from './source-reliability.js'

/**
 * The opt-in layers (default OFF, one `AUDIT_*` flag each) the operator has switched on. Each flag is still read
 * where the layer runs; this only tells the policy which ones exist this turn so its record is true.
 */
export function enabledOptInLayers(env?: Record<string, string | undefined>): OptInLayer[] {
  const on: Record<OptInLayer, boolean> = {
    source_reliability: sourceReliabilityEnabled(env),
    semantic_hypotheses: semanticHypothesesEnabled(env),
    reviewer_revision: reviewerRevisionEnabled(env),
    experience_learning: experienceLearningEnabled(env),
    semantic_compaction: semanticCompactionEnabled(env),
  }
  return OPT_IN_LAYERS.filter((l) => on[l])
}

export const SEMANTIC_ESCALATIONS = [
  'semantic_contradiction', 'failure_match', 'criterion_coverage', 'change_review', 'model_inferred_facts',
] as const satisfies readonly EscalationLayer[]
export type SemanticEscalation = (typeof SEMANTIC_ESCALATIONS)[number]

export const ESCALATION_ENV: Readonly<Record<SemanticEscalation, string>> = {
  semantic_contradiction: 'AUDIT_SEMANTIC_CONTRADICTION',
  failure_match: 'AUDIT_SEMANTIC_FAILURE_MATCH',
  criterion_coverage: 'AUDIT_SEMANTIC_CRITERION_COVERAGE',
  change_review: 'AUDIT_SEMANTIC_CHANGE_REVIEW',
  model_inferred_facts: 'AUDIT_MODEL_INFERRED_FACTS',
}

/** `true`/`false` when the operator set the env var explicitly; `undefined` when unset/empty. */
export function explicitEnvOverride(varName: string, env?: Record<string, string | undefined>): boolean | undefined {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source[varName] ?? '').trim().toLowerCase()
  if (raw === '') return undefined
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

export interface EscalationPlan {
  mode: LayerPolicyMode
  tier: TurnTier
  /** The policy that executes (static under static/shadow). */
  policy: LayerPolicy
  /** Under shadow only: what adaptive would have decided. Recorded, never acted on. */
  shadow?: { policy: LayerPolicy; tier: TurnTier }
}

/** AL9a: the per-turn LLM-call budget view for a turn's signals (risk- and posture-scaled). Static mode ignores it. */
export function turnPolicyBudget(signals: TurnSignals): PolicyBudget {
  try {
    return toPolicyBudget(computeTurnCallBudget({ riskLevel: signals.riskLevel, userPosture: signals.userPosture }))
  } catch {
    return { remainingCalls: null }
  }
}

/** Resolves the executed policy for a turn. Never throws; any failure ⇒ today's static behaviour. */
export function resolveEscalationPlan(
  mode: LayerPolicyMode,
  signals: TurnSignals,
  state: RunState | undefined,
  // AL10: `shadow` records what `adaptive` would decide, so both use the v1 rules; static never reads them.
  rules: PolicyRules = mode === 'static' ? {} : ADAPTIVE_RULES_V1,
  budget: PolicyBudget = { remainingCalls: null },
): EscalationPlan {
  try {
    const moded = resolveModedLayerPolicy(mode, signals, state, budget, rules, enabledOptInLayers())
    let policy = moded.executed
    if (mode === 'adaptive' && moded.executedTier === 'T1') {
      // T1 LITE: escalations off, floor layers untouched. Restrict-only (AL-1).
      policy = { ...policy }
      for (const layer of SEMANTIC_ESCALATIONS) {
        policy[layer] = { decision: 'off', trigger: 'tier_t1', reason: 'T1 LITE turn: routine, floor layers only' }
      }
    }
    return { mode: moded.mode, tier: moded.executedTier, policy, shadow: moded.shadow }
  } catch {
    return { mode: 'static', tier: 'T2', policy: staticLayerPolicy(enabledOptInLayers()) }
  }
}

/**
 * Whether `layer`'s semantic (LLM) form runs this turn. `cheap` is a non-linguistic form, so for
 * these layers only `full` runs the LLM hook. An explicit env override wins; a missing/broken plan
 * keeps today's behaviour (ON).
 */
export function escalationEnabled(
  layer: SemanticEscalation,
  plan: EscalationPlan | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  const override = explicitEnvOverride(ESCALATION_ENV[layer], env)
  if (override !== undefined) return override
  try {
    const d: LayerDecision | undefined = plan?.policy[layer]
    return d === undefined ? true : d.decision === 'full'
  } catch {
    return true
  }
}

// ── AL8b ────────────────────────────────────────────────────────────────────────────────────────

/** The policy the harness runtime's ad hoc gates read: only an executed `adaptive` policy differs from today's. */
export function harnessGatePolicy(plan: EscalationPlan | undefined): LayerPolicy | undefined {
  return plan !== undefined && plan.mode === 'adaptive' ? plan.policy : undefined
}

/**
 * Decomposition reframe (`reframeTaskDescriptionWithLLM`). Precedence: explicit `AUDIT_DECOMPOSITION`
 * env > the policy's decision > today's ON. `cheap` has no LLM-free form ⇒ off (only `full` reframes).
 */
export function decompositionReframeEnabled(plan: EscalationPlan | undefined, env?: Record<string, string | undefined>): boolean {
  const override = explicitEnvOverride('AUDIT_DECOMPOSITION', env)
  if (override !== undefined) return override
  try {
    const d = plan?.policy.decomposition_reframe
    return d === undefined ? true : d.decision === 'full'
  } catch {
    return true
  }
}

/**
 * LLM injection detection on fetched content (AL-1 security rule). Skippable ONLY on a
 * non-linguistic proof of safety: no untrusted content in context, or no tool-capable next step.
 * Anything the policy says short of `full` without such a proof is overridden back to ON — the
 * check never trusts a message/LLM-derived signal, and the wiring re-verifies what
 * `resolveLayerPolicy` already clamps so a hand-built plan cannot bypass it.
 */
export function injectionDetectionEnabled(
  plan: EscalationPlan | undefined,
  proof: { untrustedContentInContext: boolean; toolCapableNextStep: boolean },
): boolean {
  try {
    const d = plan?.policy.injection_detection
    if (d === undefined || d.decision === 'full') return true
    return proof.untrustedContentInContext === false || proof.toolCapableNextStep === false ? false : true
  } catch {
    return true
  }
}

/** One-line reason a layer's decision is worth surfacing (escalated / skipped-with-reason), or `undefined` when routine. */
export function decisionNote(event: { decision?: string; trigger?: string }): string | undefined {
  if (event.trigger === undefined || event.trigger === 'static') return undefined
  return `${event.decision ?? 'decided'}: ${event.trigger}`
}
