import type { RiskLevel } from './turn-intent-classifier.js'
import type { ExecutionMode } from './execution-mode.js'
import type { ToolPolicyDecision } from './tool-policy.js'
import type { ProposerKind } from './assistant-types.js'

/**
 * Structured turn telemetry — deliberately name/status-only, never full message
 * content, so it's cheap to log and safe to hand to an arbitrary sink (Langfuse,
 * console, a custom collector). See PersonalAssistantOptions.onTrace.
 */
export type TraceEvent =
  | { kind: 'turn_start'; sessionId: string; message: string }
  | { kind: 'turn_end'; sessionId: string; status: 'ok' | 'needs_approval' | 'escalated' | 'needs_clarification' | 'needs_plan_approval' }
  | { kind: 'risk_classified'; riskLevel: RiskLevel; requiresApproval: boolean }
  | { kind: 'triviality_classified'; isTrivial: boolean }
  | { kind: 'plan_classified'; isCandidate: boolean; matchedTemplate: string | null }
  | { kind: 'plan_updated'; templateName: string | null; completionPct: number }
  | { kind: 'harness_node'; node: string; stepsUsed: number }
  | { kind: 'tool_call'; tool: string; ok: boolean }
  | { kind: 'escalation'; reason: string }
  | { kind: 'error'; message: string }
  /**
   * One of the harness's 11 layers did (or explicitly skipped) real work this step —
   * see the internal plan Phase 2/3.1. `layer` is a stable slug
   * ('world_model' | 'evidence_reasoning' | 'hypothesis' | 'contradiction' | 'diagnostics' |
   * 'control_state' | 'planning' | 'execution' | 'verification' | 'recovery' | 'reviewer_pass'),
   * not a free-text name, so a "Why?"/`/layers` renderer can key off it directly.
   */
  | { kind: 'layer_activity'; layer: string; fired: boolean; reason: string }
  /**
   * A prior-turn harness checkpoint (see runTurn's runId doc comment — left behind when a
   * process died mid-run before reaching normal cleanup) failed to resume `failedAttempts` times
   * in a row and was discarded automatically instead of being retried again; this turn started
   * fresh instead of resuming it. See PersonalAssistant.clearCheckpoint for the manual
   * equivalent, and RESUME_ATTEMPT_CAP in assistant.ts for the threshold.
   */
  | { kind: 'checkpoint_discarded'; sessionId: string; failedAttempts: number }
  /**
   * Phase 4 of the internal plan — see
   * execution-mode.ts's own doc comment for each mode's guarantee level.
   */
  | { kind: 'execution_mode_classified'; mode: ExecutionMode }
  /**
   * ToolPolicy's decision for one specific tool call, before it runs — the deterministic,
   * harness-state-informed gate replacing "advisory classification checked after the fact" (see
   * tool-policy.ts).
   */
  | { kind: 'tool_policy_decision'; tool: string; decision: ToolPolicyDecision; reason: string }
  /**
   * Which proposer drove this turn — 'posthoc' (flag OFF, or a trivial / no-tool turn),
   * 'flat-oneloop', or 'batch-oneloop' (both flag ON). Emitted once per turn from runTurn, right
   * after `useOneLoop` is resolved. See AssistantTurnResult.proposerKind and
   * the internal plan phase B1 for why this exists.
   */
  | { kind: 'proposer_selected'; proposerKind: ProposerKind }
  /**
   * P9 of the internal plan — the lightweight plan-sketch delegate
   * (PlanSketchService) ran. `requestPreview` is truncated to stay name/status-only per this
   * type's own doc comment, not the full request text. Distinct from `plan_classified`/
   * `plan_updated`, which are about the stateful drafting/approval machinery (PlanDraftingService)
   * this delegate deliberately never touches (INV-35).
   */
  | { kind: 'plan_sketch'; requestPreview: string }
  /**
   * P10 of the internal plan — a write_file/run_shell_command/send_email
   * proposal was auto-applied instead of staged for approval because it was proposed while
   * `taskId` (part of a plan approved with `'approve_trusted'`) was the currently RUNNING task —
   * see PlanRecord.trustApprovedSteps and INV-36. The action itself still went through
   * ActionApprovalService.resolvePendingAction exactly as a manually-approved one would (same
   * transcript entry, same real-undo record) — this event is purely additional "why no approval
   * prompt" observability, name/status-only per this type's own doc comment.
   */
  | { kind: 'plan_trust_auto_applied'; pendingActionKind: 'write' | 'shell' | 'email'; taskId: string }
