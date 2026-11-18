import type { RiskLevel } from './turn-intent-classifier.js'

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
export type ToolPolicyDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'

/** Structural subset of packages/harness's ControlState — only the fields this policy reads,
 * so callers can pass either a live ControlState instance or a plain matching object without an
 * import-time dependency on the class itself. */
export interface ToolPolicyControlState {
  permission: 'ALLOW' | 'DENY'
  execution_mode: 'NORMAL' | 'CAUTIOUS' | 'RECOVERY'
  escalation: 'NONE' | 'HUMAN_REQUIRED' | 'SYSTEM_BREAKING'
}

export interface ToolPolicyInput {
  toolName: string
  riskHint: RiskLevel
  /**
   * The harness's live ControlState for this turn, when one has actually been computed —
   * `undefined` for the pre-evidence baseline before any tool call this turn has produced
   * observations to resolve a real ControlState from (see resolve-control-state.ts: a fresh
   * WorldModel with zero evidence resolves to an uninformative NORMAL/ALLOW every time, so
   * treating "not yet computed" the same as "computed and permissive" costs nothing here).
   */
  controlState?: ToolPolicyControlState
  /** Set to 'untrusted_mail' when the turn has shown mail text to the model. */
  origin?: ToolCallOrigin
}

export interface ToolPolicyResult {
  decision: ToolPolicyDecision
  reason: string
  /** Where the proposing context came from, echoed so the approval UI can show it. */
  origin?: ToolCallOrigin
}

/** `untrusted_mail`: the call was proposed in a turn that read mail text. */
export type ToolCallOrigin = 'user' | 'untrusted_mail'

/** Mail tool risk classes (plan section 6). */
export type MailToolClass = 'read_only' | 'reversible' | 'creates_for_review' | 'outward_or_destructive'

export const MAIL_TOOL_CLASSES: Readonly<Record<string, MailToolClass>> = {
  mail_search: 'read_only',
  mail_read_thread: 'read_only',
  mail_list_folders: 'read_only',
  mail_summarise: 'read_only',
  mail_list_todo: 'read_only',
  mail_count: 'read_only',
  mail_catch_up: 'read_only',
  mail_move: 'reversible',
  mail_label: 'reversible',
  mail_archive: 'reversible',
  mail_mark_read: 'reversible',
  mail_flag: 'reversible',
  mail_snooze: 'reversible',
  mail_create_draft: 'creates_for_review',
  mail_propose_folder: 'creates_for_review',
  mail_propose_rule: 'creates_for_review',
  mail_send: 'outward_or_destructive',
  mail_delete_permanent: 'outward_or_destructive',
  mail_empty_trash: 'outward_or_destructive',
  mail_unsubscribe: 'outward_or_destructive',
  mail_create_auto_rule: 'outward_or_destructive',
}

/** Class of a mail tool, or undefined for a non-mail tool. An unlisted `mail_*` name is treated as outward (fail safe). */
export function mailToolClass(toolName: string): MailToolClass | undefined {
  const known = MAIL_TOOL_CLASSES[toolName]
  if (known) return known
  return toolName.startsWith('mail_') ? 'outward_or_destructive' : undefined
}

/** Tool names that are always staged for human approval, independent of risk classification or
 * control state — file-tools.ts's write_file/run_shell_command unconditional gate, expressed here
 * as policy data instead of duplicated per call site. */
const ALWAYS_REQUIRE_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['write_file', 'run_shell_command', 'send_email'])

export function evaluateToolPolicy(input: ToolPolicyInput): ToolPolicyResult {
  const result = evaluateBase(input)
  return input.origin ? { ...result, origin: input.origin } : result
}

function evaluateBase(input: ToolPolicyInput): ToolPolicyResult {
  const mailClass = mailToolClass(input.toolName)
  if (mailClass === 'outward_or_destructive') {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `${input.toolName} is outward or destructive mail action — always staged for approval of the concrete action, never auto-approved${input.origin === 'untrusted_mail' ? ' (proposed after reading untrusted mail)' : ''}`,
    }
  }
  if (mailClass && mailClass !== 'read_only' && input.origin === 'untrusted_mail') {
    return { decision: 'REQUIRE_APPROVAL', reason: `${input.toolName} was proposed after reading untrusted mail — staged for approval, origin shown` }
  }
  if (ALWAYS_REQUIRE_APPROVAL_TOOLS.has(input.toolName)) {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `${input.toolName} is a consequential tool — always staged for approval, independent of risk classification or control state`,
    }
  }

  if (input.controlState?.permission === 'DENY') {
    return { decision: 'DENY', reason: 'harness control state denies action this turn' }
  }

  if (input.controlState?.escalation === 'HUMAN_REQUIRED' || input.controlState?.escalation === 'SYSTEM_BREAKING') {
    return {
      decision: 'REQUIRE_APPROVAL',
      reason: `harness escalation state (${input.controlState.escalation}) requires human review before continuing`,
    }
  }

  // A classifier failure (failSafeClassification) returns riskHint: 'UNKNOWN' — require approval
  // rather than assume safety, same fail-safe direction turn-intent-classifier.ts's own
  // requiresApproval: true already takes for the message-level gate.
  if (input.riskHint === 'UNKNOWN') {
    return { decision: 'REQUIRE_APPROVAL', reason: 'risk classification failed (fail-safe UNKNOWN) — requiring approval rather than assuming safety' }
  }

  return {
    decision: 'ALLOW',
    reason: input.controlState
      ? `harness control state permits (execution_mode=${input.controlState.execution_mode})`
      : 'no harness control state resolved yet this turn — allowed at the pre-evidence baseline',
  }
}
