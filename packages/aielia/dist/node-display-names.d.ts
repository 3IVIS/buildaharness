import { LayerActivityEvent } from '@buildaharness/harness';
export declare function nodeDisplayName(node: string | undefined): string | undefined;
/**
 * The 11 harness layer slugs, in the fixed order the internal developer notes' architecture table lists them —
 * used by both the CLI's `/layers` and chat-ui's layer grid to render a stable 2-3 letter
 * code per layer (Phase 3.3 of the harness layer activation plan). Matches the `layer` field
 * on the `layer_activity` TraceEvent (see trace-events.ts) and HarnessRunOptions'
 * LayerActivityEvent (see @buildaharness/harness).
 */
export declare const LAYER_ORDER: readonly ["world_model", "evidence_reasoning", "hypothesis", "contradiction", "diagnostics", "control_state", "planning", "execution", "verification", "recovery", "reviewer_pass"];
export type LayerSlug = (typeof LAYER_ORDER)[number];
export declare const LAYER_DISPLAY_NAME: Record<LayerSlug, string>;
export declare const LAYER_SHORT_CODE: Record<LayerSlug, string>;
export declare function nodeToLayer(node: string | undefined): LayerSlug | undefined;
export interface WhyChainItem {
    layer: LayerSlug;
    reason: string;
}
/**
 * Collapses a turn's raw layerActivity (one event per layer per main-loop iteration — see
 * harness-runtime.ts's onLayerActivity doc comment) down to just the layers that fired, in the
 * order they fired, merging consecutive re-fires of the same layer (back-to-back loop
 * iterations) into a single link. Used by run-explain.ts, which both the CLI's `/why` and chat-ui's `/why` print, so both
 * surfaces summarize a turn identically instead of drifting apart.
 */
export declare function buildWhyChain(layerActivity: LayerActivityEvent[]): WhyChainItem[];
