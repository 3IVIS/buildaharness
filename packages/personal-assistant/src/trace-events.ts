import type { RiskLevel } from './risk-classifier.js'

/**
 * Structured turn telemetry — deliberately name/status-only, never full message
 * content, so it's cheap to log and safe to hand to an arbitrary sink (Langfuse,
 * console, a custom collector). See PersonalAssistantOptions.onTrace.
 */
export type TraceEvent =
  | { kind: 'turn_start'; sessionId: string; message: string }
  | { kind: 'turn_end'; sessionId: string; status: 'ok' | 'needs_approval' | 'escalated' }
  | { kind: 'risk_classified'; riskLevel: RiskLevel; requiresApproval: boolean }
  | { kind: 'triviality_classified'; isTrivial: boolean }
  | { kind: 'plan_classified'; isCandidate: boolean; matchedTemplate: string | null }
  | { kind: 'plan_updated'; templateName: string; completionPct: number }
  | { kind: 'harness_node'; node: string; stepsUsed: number }
  | { kind: 'tool_call'; tool: string; ok: boolean }
  | { kind: 'escalation'; reason: string }
  | { kind: 'error'; message: string }
  /**
   * One of the harness's 11 layers did (or explicitly skipped) real work this step —
   * see plans/harness_layer_activation_plan.html Phase 2/3.1. `layer` is a stable slug
   * ('world_model' | 'evidence_reasoning' | 'hypothesis' | 'contradiction' | 'diagnostics' |
   * 'control_state' | 'planning' | 'execution' | 'verification' | 'recovery' | 'reviewer_pass'),
   * not a free-text name, so a "Why?"/`/layers` renderer can key off it directly.
   */
  | { kind: 'layer_activity'; layer: string; fired: boolean; reason: string }
