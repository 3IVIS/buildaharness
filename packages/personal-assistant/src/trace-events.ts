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
  | { kind: 'harness_node'; node: string; stepsUsed: number }
  | { kind: 'tool_call'; tool: string; ok: boolean }
  | { kind: 'escalation'; reason: string }
  | { kind: 'error'; message: string }
