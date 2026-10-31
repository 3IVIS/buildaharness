import { RiskLevel } from './turn-intent-classifier.js';
/**
 * Phase 4 of the internal plan: the deterministic,
 * authoritative decision point for whether a specific tool call may proceed — replacing "advisory
 * LLM classification, checked after the fact" with "deterministic policy informed by real harness
 * state, checked before execution" (the substantive fix both external architecture critiques
 * asked for).
 *
 * Modeled on file-tools.ts's stagePendingAction gate, which already runs unconditionally on a
 * tool call's own concrete arguments (the literal path/content or command/cwd), independent of
 * whatever risk-classifier text patterns concluded about the user's phrasing — see that function's
 * own doc comment for the "gate on the concrete tool call, not the free text" rationale this
 * module generalizes into a single, reusable, unit-testable decision function instead of the
 * pattern living only inline at each tool's own call site.
 *
 * `riskHint` (turn-intent-classifier.ts's RiskLevel, including the fail-safe 'UNKNOWN') is an
 * input/signal, never itself the gate — a HIGH riskHint can't downgrade a real harness DENY, and a
 * LOW riskHint can't upgrade past what the concrete tool call and control state already require.
 */
export type ToolPolicyDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
/** Structural subset of packages/harness's ControlState — only the fields this policy reads,
 * so callers can pass either a live ControlState instance or a plain matching object without an
 * import-time dependency on the class itself. */
export interface ToolPolicyControlState {
    permission: 'ALLOW' | 'DENY';
    execution_mode: 'NORMAL' | 'CAUTIOUS' | 'RECOVERY';
    escalation: 'NONE' | 'HUMAN_REQUIRED' | 'SYSTEM_BREAKING';
}
export interface ToolPolicyInput {
    toolName: string;
    riskHint: RiskLevel;
    /**
     * The harness's live ControlState for this turn, when one has actually been computed —
     * `undefined` for the pre-evidence baseline before any tool call this turn has produced
     * observations to resolve a real ControlState from (see resolve-control-state.ts: a fresh
     * WorldModel with zero evidence resolves to an uninformative NORMAL/ALLOW every time, so
     * treating "not yet computed" the same as "computed and permissive" costs nothing here).
     */
    controlState?: ToolPolicyControlState;
}
export interface ToolPolicyResult {
    decision: ToolPolicyDecision;
    reason: string;
}
export declare function evaluateToolPolicy(input: ToolPolicyInput): ToolPolicyResult;
