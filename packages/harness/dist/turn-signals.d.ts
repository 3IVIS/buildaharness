import { TurnComplexitySignal } from './harness-runtime.js';
/**
 * AL5a of the adaptive layer selection plan. `TurnSignals` generalises `TurnComplexitySignal`
 * (kept as a compatible subset — every field of the old signal is still here, unchanged) with the
 * user-input signals the consolidated turn classifier emits in its existing single call (AL-7: no
 * new per-turn LLM call), plus run-state features computed from state rather than language.
 * Every added field is optional and read by nothing yet — AL7's `LayerPolicy` is the consumer —
 * so a caller that ignores them gets byte-identical behaviour (AL-2).
 */
export type TurnAmbiguity = 'none' | 'some' | 'high' | 'unknown';
export type TurnUserPosture = 'informational' | 'directive' | 'exploratory' | 'corrective' | 'unknown';
/** What a tool does to the world, independent of how it is named or what the user said. */
export type ToolEffectClass = 'read' | 'write' | 'execute' | 'network';
export type Trend = 'improving' | 'flat' | 'degrading' | 'unknown';
/** State-derived features (never language-derived) the layer policy reads. */
export interface RunState {
    consecutiveFailures: number;
    turnDepth: number;
    cumulativeSpend: number;
    /** null when the session has no budget. */
    sessionBudget: number | null;
    diagnosticsTrend: Trend;
    verificationTrend: Trend;
    /** tool name → success rate in [0,1]; absent when a tool has no history. */
    toolReliability: Record<string, number>;
    untrustedContentInContext: boolean;
}
export interface TurnSignals extends TurnComplexitySignal {
    /** Tools actually exercised this turn — the pre-AL5a meaning of `consequentialTools`, still what drives the evidence-escalation gate. */
    exercisedTools?: Set<string>;
    /** The turn classifier's conservative triviality verdict — the input to today's FAST / full split (AL7b). */
    isTrivial?: boolean;
    needsGrounding?: boolean;
    ambiguity?: TurnAmbiguity;
    userPosture?: TurnUserPosture;
    pushbackOnPriorTurn?: boolean;
    statesConstraint?: boolean;
    runState?: RunState;
}
/**
 * The tools a turn may invoke whose effect class mutates the world (write / execute). `network`
 * here means outbound read-only egress (search, fetch) and is not consequential. A tool absent
 * from the manifest is treated as consequential — an unknown effect is not verified-safe.
 */
export declare function deriveConsequentialTools(toolNames: Iterable<string>, manifest: Record<string, ToolEffectClass>): Set<string>;
/** Compares the mean of the later half of a series to the earlier half; higher-is-better unless `lowerIsBetter`. */
export declare function computeTrend(series: number[], lowerIsBetter?: boolean, epsilon?: number): Trend;
export interface RunStateInput {
    /** Outcomes in order, oldest first; true = failure. */
    outcomes?: boolean[];
    turnDepth?: number;
    cumulativeSpend?: number;
    sessionBudget?: number | null;
    /** Per-iteration health scores (higher is better), oldest first. */
    diagnosticsScores?: number[];
    verificationScores?: number[];
    toolReliability?: Record<string, number>;
    untrustedContentInContext?: boolean;
}
export declare function computeRunState(input?: RunStateInput): RunState;
