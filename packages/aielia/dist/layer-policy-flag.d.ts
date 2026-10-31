import { DEFAULT_LAYER_POLICY_MODE, LayerPolicyMode } from '@buildaharness/harness';
export type { LayerPolicyMode };
export { DEFAULT_LAYER_POLICY_MODE };
export declare function isLayerPolicyMode(v: unknown): v is LayerPolicyMode;
/** The mode a resolved config means; unset ⇒ the package default (static). */
export declare function resolveLayerPolicyModeFromConfig(mode: LayerPolicyMode | undefined): LayerPolicyMode;
/** The single place a resolved `config.layerPolicyMode` becomes "does adaptive behaviour execute?". Shadow does not. */
export declare function isAdaptivePolicyEnabled(mode: LayerPolicyMode | undefined): boolean;
/** True when decisions should be computed and recorded (shadow or adaptive). */
export declare function isPolicyRecordingEnabled(mode: LayerPolicyMode | undefined): boolean;
/** Unset/empty ⇒ default silently; an unrecognized value ⇒ default with a warning naming `varName`. */
export declare function normalizeLayerPolicyMode(raw: string | undefined, varName?: string): LayerPolicyMode;
export declare function resolveLayerPolicyMode(env: NodeJS.ProcessEnv): LayerPolicyMode;
