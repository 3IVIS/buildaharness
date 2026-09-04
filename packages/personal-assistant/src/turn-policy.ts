import type { RiskLevel } from './turn-intent-classifier.js'

/**
 * Phase D3 (plans/harness_consolidation_and_control_plane_plan.html, A3): the deterministic,
 * authoritative decision point for whether a turn's message-level risk requires human approval
 * before the turn proceeds — the message-level analog of tool-policy.ts's evaluateToolPolicy().
 *
 * turn-intent-classifier.ts's own `requiresApproval` field is computed from the same
 * riskLevel/isBulkReminderRequest signals and still exists for trace/display purposes, but no
 * gating call site should read that boolean directly — TurnPolicyInput deliberately has no
 * `requiresApproval` field to read, so a gate built on this module always recomputes the decision
 * from the underlying signals rather than trusting a pass-through boolean (INV-14: a consequential
 * decision cannot be set by LLM output alone). See turn-interpreter.ts and assistant.ts's
 * classifyAndTraceExecutionMode call sites for where this replaces a direct
 * `classification.requiresApproval` read.
 */
export type TurnPolicyDecision = 'ALLOW' | 'REQUIRE_APPROVAL'

export interface TurnPolicyInput {
  /** turn-intent-classifier.ts's RiskLevel — a signal, never itself the gate (same contract
   *  tool-policy.ts's ToolPolicyInput.riskHint documents). */
  riskHint: RiskLevel
  /** turn-intent-classifier.ts's own isBulkReminderRequest verdict — only meaningful alongside a
   *  MEDIUM riskHint (see turn-intent-classifier.ts), but read here unconditionally since a
   *  MEDIUM-only precondition on this field is itself already enforced upstream. */
  isBulkReminderRequest: boolean
}

export interface TurnPolicyResult {
  decision: TurnPolicyDecision
  reason: string
}

export function evaluateTurnPolicy(input: TurnPolicyInput): TurnPolicyResult {
  // A classifier failure (failSafeClassification) surfaces as riskHint: 'UNKNOWN' — require
  // approval rather than assume safety, the same fail-safe direction tool-policy.ts's own
  // UNKNOWN branch takes.
  if (input.riskHint === 'UNKNOWN') {
    return { decision: 'REQUIRE_APPROVAL', reason: 'risk classification failed (fail-safe UNKNOWN) — requiring approval rather than assuming safety' }
  }
  if (input.riskHint === 'HIGH') {
    return { decision: 'REQUIRE_APPROVAL', reason: 'message-level risk classified HIGH' }
  }
  if (input.isBulkReminderRequest) {
    return { decision: 'REQUIRE_APPROVAL', reason: 'request looks like more than one reminder created in a single turn' }
  }
  return { decision: 'ALLOW', reason: 'no message-level signal requires approval' }
}

export interface AbandonPolicyInput {
  /** Structural fact — an active durable plan record actually exists for this session,
   *  independent of anything the LLM said this turn. */
  hasActivePlan: boolean
  /** turn-intent-classifier.ts's isAbandonRequest verdict — a signal, never itself sufficient:
   *  an LLM claiming "abandon the plan" means nothing when no plan is actually active. */
  abandonHint: boolean
}

/**
 * The deterministic gate for plan abandonment: `abandonHint` alone is never enough — it only
 * takes effect when `hasActivePlan` (independent of the LLM call) is also true. Centralizes the
 * same check turn-intent-classifier.ts and turn-interpreter.ts each already performed inline, so
 * it's asserted once, not maintained in two places that could drift apart.
 */
export function evaluateAbandonPolicy(input: AbandonPolicyInput): boolean {
  return input.hasActivePlan && input.abandonHint
}
