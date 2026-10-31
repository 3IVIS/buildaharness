import { LayerPolicy, OptInLayer, PolicyBudget, PolicyRules } from './layer-policy.js';
import { RunState, TurnSignals } from './turn-signals.js';
/**
 * AL7b of the adaptive layer selection plan: turn tiers, the static/shadow/adaptive mode switch.
 *
 *  - `static`   — today's behaviour exactly (the documented kill switch).
 *  - `shadow`   — computes the adaptive decisions and records them, but EXECUTES the static ones;
 *                 everything behavioural equals `static` (AL-2), so it is safe on real use.
 *  - `adaptive` — executes the resolved policy.
 */
export type LayerPolicyMode = 'static' | 'shadow' | 'adaptive';
export declare const LAYER_POLICY_MODES: readonly LayerPolicyMode[];
export declare const DEFAULT_LAYER_POLICY_MODE: LayerPolicyMode;
/** T0 FAST = no harness run; T1 LITE = floor layers only (escalations at `cheap`/`off`); T2 FULL = today's full harness. */
export type TurnTier = 'T0' | 'T1' | 'T2';
/**
 * Today's split is binary: `isTrivial` ⇒ FAST (T0), everything else ⇒ full (T2). T1 is reachable
 * only under `adaptive`, and only on positive, non-linguistic evidence of a routine turn: LOW risk,
 * no tool that could mutate the world, single-step, no plan, no correction/constraint from the
 * user, unambiguous, and a healthy run with no untrusted content in context. Any missing signal
 * keeps T2 (unknown is never verified-routine).
 */
export declare function resolveTurnTier(signals: TurnSignals, state: RunState | undefined, mode?: LayerPolicyMode): TurnTier;
export interface ModedLayerPolicy {
    mode: LayerPolicyMode;
    /** What actually runs. */
    executed: LayerPolicy;
    executedTier: TurnTier;
    /** Present under `shadow` only: what `adaptive` would have decided. Record it; never act on it. */
    shadow?: {
        policy: LayerPolicy;
        tier: TurnTier;
    };
}
/** Applies `mode`: static and shadow execute static behaviour; only adaptive executes the resolved policy. Never throws. */
export declare function resolveModedLayerPolicy(mode: LayerPolicyMode, signals: TurnSignals, state: RunState | undefined, budget: PolicyBudget, rules?: PolicyRules, enabledOptIn?: Iterable<OptInLayer>): ModedLayerPolicy;
