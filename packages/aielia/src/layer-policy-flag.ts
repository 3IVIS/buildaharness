/**
 * AL7b of plans/adaptive_layer_selection_plan.html — `layerPolicyMode`, exposed exactly like
 * `goalGraphMode` (env `ASSISTANT_LAYER_POLICY`, `/config set layerPolicyMode`, `VITE_ASSISTANT_LAYER_POLICY`).
 *
 *  - 'static'   (default, and the documented kill switch) — today's behaviour, byte-for-byte.
 *  - 'shadow'   — computes the adaptive decisions and records them, but executes static behaviour.
 *  - 'adaptive' — executes the adaptive policy.
 *
 * `AssistantConfig.layerPolicyMode` stays out of DEFAULT_CONFIG (undefined = "the package owns the
 * default"), so every consumer goes through `resolveLayerPolicyMode` / `isAdaptivePolicyEnabled`.
 */
import { DEFAULT_LAYER_POLICY_MODE, LAYER_POLICY_MODES, type LayerPolicyMode } from '@buildaharness/harness'

export type { LayerPolicyMode }
export { DEFAULT_LAYER_POLICY_MODE }

export function isLayerPolicyMode(v: unknown): v is LayerPolicyMode {
  return typeof v === 'string' && (LAYER_POLICY_MODES as readonly string[]).includes(v)
}

/** The mode a resolved config means; unset ⇒ the package default (static). */
export function resolveLayerPolicyModeFromConfig(mode: LayerPolicyMode | undefined): LayerPolicyMode {
  return mode ?? DEFAULT_LAYER_POLICY_MODE
}

/** The single place a resolved `config.layerPolicyMode` becomes "does adaptive behaviour execute?". Shadow does not. */
export function isAdaptivePolicyEnabled(mode: LayerPolicyMode | undefined): boolean {
  return resolveLayerPolicyModeFromConfig(mode) === 'adaptive'
}

/** True when decisions should be computed and recorded (shadow or adaptive). */
export function isPolicyRecordingEnabled(mode: LayerPolicyMode | undefined): boolean {
  return resolveLayerPolicyModeFromConfig(mode) !== 'static'
}

/** Unset/empty ⇒ default silently; an unrecognized value ⇒ default with a warning naming `varName`. */
export function normalizeLayerPolicyMode(raw: string | undefined, varName = 'ASSISTANT_LAYER_POLICY'): LayerPolicyMode {
  if (raw === undefined || raw === '') return DEFAULT_LAYER_POLICY_MODE
  if (isLayerPolicyMode(raw)) return raw
  console.error(`[warning] ${varName}="${raw}" is not "static", "shadow" or "adaptive" — using the default (${DEFAULT_LAYER_POLICY_MODE}).`)
  return DEFAULT_LAYER_POLICY_MODE
}

export function resolveLayerPolicyMode(env: NodeJS.ProcessEnv): LayerPolicyMode {
  return normalizeLayerPolicyMode(env.ASSISTANT_LAYER_POLICY)
}
