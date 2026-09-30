import { resolveLayerPolicy, staticLayerPolicy, type LayerPolicy, type OptInLayer, type PolicyBudget, type PolicyRules } from './layer-policy.js'
import type { RunState, TurnSignals } from './turn-signals.js'

/**
 * AL7b of the adaptive layer selection plan: turn tiers, the static/shadow/adaptive mode switch.
 *
 *  - `static`   — today's behaviour exactly (the documented kill switch).
 *  - `shadow`   — computes the adaptive decisions and records them, but EXECUTES the static ones;
 *                 everything behavioural equals `static` (AL-2), so it is safe on real use.
 *  - `adaptive` — executes the resolved policy.
 */
export type LayerPolicyMode = 'static' | 'shadow' | 'adaptive'
export const LAYER_POLICY_MODES: readonly LayerPolicyMode[] = ['static', 'shadow', 'adaptive']
export const DEFAULT_LAYER_POLICY_MODE: LayerPolicyMode = 'static'

/** T0 FAST = no harness run; T1 LITE = floor layers only (escalations at `cheap`/`off`); T2 FULL = today's full harness. */
export type TurnTier = 'T0' | 'T1' | 'T2'

/**
 * Today's split is binary: `isTrivial` ⇒ FAST (T0), everything else ⇒ full (T2). T1 is reachable
 * only under `adaptive`, and only on positive, non-linguistic evidence of a routine turn: LOW risk,
 * no tool that could mutate the world, single-step, no plan, no correction/constraint from the
 * user, unambiguous, and a healthy run with no untrusted content in context. Any missing signal
 * keeps T2 (unknown is never verified-routine).
 */
export function resolveTurnTier(
  signals: TurnSignals,
  state: RunState | undefined,
  mode: LayerPolicyMode = DEFAULT_LAYER_POLICY_MODE,
): TurnTier {
  if (signals.isTrivial === true) return 'T0'
  if (mode !== 'adaptive') return 'T2'
  try {
    const routine =
      signals.riskLevel === 'LOW' &&
      signals.consequentialTools !== undefined && signals.consequentialTools.size === 0 &&
      signals.taskCount <= 1 &&
      signals.hasDurablePlan === false &&
      signals.pushbackOnPriorTurn === false &&
      signals.statesConstraint === false &&
      signals.ambiguity === 'none' &&
      state !== undefined &&
      state.untrustedContentInContext === false &&
      state.consecutiveFailures === 0 &&
      state.diagnosticsTrend !== 'degrading' &&
      state.verificationTrend !== 'degrading'
    return routine ? 'T1' : 'T2'
  } catch {
    return 'T2'
  }
}

export interface ModedLayerPolicy {
  mode: LayerPolicyMode
  /** What actually runs. */
  executed: LayerPolicy
  executedTier: TurnTier
  /** Present under `shadow` only: what `adaptive` would have decided. Record it; never act on it. */
  shadow?: { policy: LayerPolicy; tier: TurnTier }
}

/** Applies `mode`: static and shadow execute static behaviour; only adaptive executes the resolved policy. Never throws. */
export function resolveModedLayerPolicy(
  mode: LayerPolicyMode,
  signals: TurnSignals,
  state: RunState | undefined,
  budget: PolicyBudget,
  rules: PolicyRules = {},
  enabledOptIn?: Iterable<OptInLayer>,
): ModedLayerPolicy {
  const staticTier = resolveTurnTier(signals, state, 'static')
  if (mode === 'adaptive') {
    return {
      mode,
      executed: resolveLayerPolicy(signals, state, budget, rules, enabledOptIn),
      executedTier: resolveTurnTier(signals, state, 'adaptive'),
    }
  }
  const out: ModedLayerPolicy = { mode: mode === 'shadow' ? 'shadow' : 'static', executed: staticLayerPolicy(enabledOptIn), executedTier: staticTier }
  if (mode === 'shadow') {
    try {
      out.shadow = {
        policy: resolveLayerPolicy(signals, state, budget, rules, enabledOptIn),
        tier: resolveTurnTier(signals, state, 'adaptive'),
      }
    } catch {
      // shadow is observational only — a failure here must never affect the turn
    }
  }
  return out
}
