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
  staticLayerPolicy,
  type EscalationLayer,
  type LayerDecision,
  type LayerPolicy,
  type LayerPolicyMode,
  type PolicyRules,
  type RunState,
  type TurnSignals,
  type TurnTier,
} from '@buildaharness/harness'

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

/** Resolves the executed policy for a turn. Never throws; any failure ⇒ today's static behaviour. */
export function resolveEscalationPlan(
  mode: LayerPolicyMode,
  signals: TurnSignals,
  state: RunState | undefined,
  rules: PolicyRules = {},
): EscalationPlan {
  try {
    const moded = resolveModedLayerPolicy(mode, signals, state, { remainingCalls: null }, rules)
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
    return { mode: 'static', tier: 'T2', policy: staticLayerPolicy() }
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
