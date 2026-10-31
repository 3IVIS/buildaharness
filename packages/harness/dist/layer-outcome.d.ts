import { Decision, LayerPolicy } from './layer-policy.js';
/** What one layer did this turn. */
export interface LayerOutcome {
    layer: string;
    fired: boolean;
    calls: number;
    tokens: number;
    /** The layer changed the reply or a verdict (a finding, not mere activity). */
    changed: boolean;
    /** The finding was acted on (it changed something and the turn ran through to completion). */
    actedOn: boolean;
}
export interface LayerOutcomeRow {
    kind: 'layer_outcome';
    runId: string;
    mode: string;
    tier: string;
    layers: LayerOutcome[];
    /** Unknown at write time; filled by a later `layer_outcome_feedback` row from the next turn's `pushbackOnPriorTurn`. */
    nextTurnCorrection: boolean | null;
}
/** Written by the NEXT turn: whether it corrected the turn `runId`. */
export interface LayerOutcomeFeedbackRow {
    kind: 'layer_outcome_feedback';
    runId: string;
    nextTurnCorrection: boolean;
}
export interface ShadowDisagreement {
    layer: string;
    executed: Decision;
    shadow: Decision;
    trigger: string;
}
/** Shadow mode: what adaptive would have decided next to what actually ran. */
export interface ShadowRow {
    kind: 'shadow_turn';
    runId: string;
    executedTier: string;
    shadowTier: string;
    /** Every layer where the shadow decision differed from the executed one. */
    disagreements: ShadowDisagreement[];
    /** LLM calls the executed (static) policy would draw vs what the shadow policy would. */
    executedCalls: number;
    shadowCalls: number;
    /** Actual LLM calls the turn made across the instrumented escalation layers (measured, not modelled). */
    observedCalls: number;
    /** Measured calls per escalation layer (only layers that made at least one). Absent on rows written before it existed. */
    observedByLayer?: Record<string, number>;
    verificationFailed: boolean;
    nextTurnCorrection: boolean | null;
}
export type LayerTelemetryRow = LayerOutcomeRow | LayerOutcomeFeedbackRow | ShadowRow;
export interface LayerActivityLike {
    layer?: unknown;
    fired?: unknown;
    llmCalls?: unknown;
    tokens?: unknown;
}
export declare function buildLayerOutcomeRow(input: {
    runId: string;
    mode: string;
    tier: string;
    activity: readonly LayerActivityLike[];
    /** Layers that produced a finding this turn (caller decides; names only). */
    changedLayers?: readonly string[];
    completed: boolean;
    /**
     * MEASURED LLM use of the escalation layers whose hooks the host instruments (escalation-layer id → calls and tokens). Each
     * becomes its own outcome entry (`fired` = made at least one call), so `layer-yield` shows real calls and tokens instead of 0.
     * A layer that is not instrumented simply has no entry — absence means "not measured", not "made no calls".
     */
    layerUse?: Readonly<Record<string, {
        calls: number;
        tokens: number;
    }>>;
}): LayerOutcomeRow | undefined;
export declare function buildFeedbackRow(runId: string, correction: boolean): LayerOutcomeFeedbackRow | undefined;
export declare function buildShadowRow(input: {
    runId: string;
    executed: LayerPolicy;
    executedTier: string;
    shadow: {
        policy: LayerPolicy;
        tier: string;
    };
    layerCosts: Readonly<Record<string, number>>;
    observedCalls: number;
    /** Measured calls per escalation layer; layers with none are left out. */
    observedByLayer?: Readonly<Record<string, number>>;
    verificationFailed: boolean;
}): ShadowRow | undefined;
export interface LayerYield {
    layer: string;
    turns: number;
    fired: number;
    calls: number;
    tokens: number;
    changed: number;
    actedOn: number;
    /** Turns after which the next turn was a correction / turns whose correction status is known. */
    correctedNext: number;
    knownNext: number;
    /** changed / calls, or null when the layer drew no LLM calls. */
    changesPerCall: number | null;
}
export declare function summarizeLayerYield(rows: readonly LayerTelemetryRow[]): LayerYield[];
export interface ShadowLayerReport {
    layer: string;
    turns: number;
    disagreements: number;
    disagreementRate: number;
    /** Disagreements where shadow would have skipped/degraded the layer (shadow < executed). */
    wouldSkip: number;
    /** Of those, turns where the next turn (or verification) was a correction/failure — a possible miss. */
    skipCoincidedWithCorrection: number;
    skipKnown: number;
    /** MEASURED calls this layer made on the turns where the shadow policy would have skipped it — what adaptive would really have saved. */
    observedCallsSkipped: number;
}
export interface ShadowReport {
    turns: number;
    callsSaved: number;
    executedCalls: number;
    shadowCalls: number;
    /** Measured calls across the instrumented layers, and how many of them fall on turns/layers the shadow policy would have skipped. */
    observedCalls: number;
    observedCallsSkipped: number;
    layers: ShadowLayerReport[];
}
export declare function summarizeShadow(rows: readonly LayerTelemetryRow[]): ShadowReport;
/** Parses a JSONL (or JSON array) telemetry log; malformed lines are skipped. */
export declare function parseTelemetryLog(text: string): LayerTelemetryRow[];
