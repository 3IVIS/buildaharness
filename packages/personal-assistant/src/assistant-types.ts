import type { RiskState, LayerActivityEvent } from '@buildaharness/harness'
import type { TokenUsage } from '@buildaharness/runtime'
import type { AnswerClaim } from './answer-claim.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import type { AssistantSource } from './assistant-source.js'
import type { BatchBudgetTrace } from './agent-loop.js'
import type { PlanPosition } from './plan-store.js'

/**
 * The public result/progress shapes every extracted module (ActionApprovalService,
 * TurnInterpreter, HarnessBridge, ResponseService) builds or consumes — split into its own file
 * so those modules can depend on the shapes without depending on assistant.ts itself (which, in
 * turn, depends on all of them to assemble the sequencer). assistant.ts re-exports these under
 * their original names for full backward compatibility with existing imports
 * (index.ts/cli.ts/cli-session.ts/assistant.test.ts).
 */
export interface AssistantTrace {
  nodeExecutionOrder: string[]
  verificationHealth: { strength: number; feasibility: number }
  /** Every one of the 11 harness layers' fired/skipped report for this turn — see LayerActivityEvent. Powers the "Why?" panel's "What I checked" list and the 11-layer status grid. */
  layerActivity: LayerActivityEvent[]
  /**
   * Present only when the batch-research path (batch-list-detector.ts / AgentLoop.runBatchToolLoop)
   * drove this turn — absent otherwise, same "absent when unused" convention as sources/usage.
   */
  batchBudget?: BatchBudgetTrace
}

export interface AssistantTurnResult {
  status: 'ok' | 'needs_approval' | 'escalated'
  reply: string | null
  reason?: string
  riskLevel?: TurnIntentClassification['riskLevel']
  controlState?: { riskState: RiskState; escalationReason: string | null }
  stepsUsed?: number
  /** True when the turn was answered by the triviality fast path — no HarnessRuntime.run() this turn. */
  harnessSkipped?: boolean
  /** Structured harness telemetry for a "Why?" disclosure — the step sequence and verification confidence, not free-text reasoning. */
  trace?: AssistantTrace
  /** Set only when `needs_approval` was triggered by a `write_file`/`run_shell_command` tool call — pass back into `turn(message, { approved, pendingActionId })` to apply or discard it. */
  pendingActionId?: string
  /** Which kind of action `pendingActionId` refers to — a write shows path + content preview, a shell command shows the exact command + resolved cwd, a batch confirmation shows the projected remaining search count, a revert (staged only via /undo-action, never by the model) shows which paths will be restored/removed. */
  pendingActionKind?: 'write' | 'shell' | 'batch' | 'revert'
  /** Real read_file/list_directory calls made while producing this reply, in call order. Only set when fileTools is configured and at least one such call happened this turn. */
  sources?: AssistantSource[]
  /**
   * Structured, durable plan progress — present whenever a templated plan (new or
   * resumed) drove this turn's initialTasks, absent otherwise (same "absent when
   * unused" convention as trace/sources). Unlike trace, this can be non-null across
   * many consecutive turns in the same session: the plan persists in `memory` until
   * every task is COMPLETE or the user abandons it. See plan-store.ts.
   */
  planStatus?: {
    templateName: string
    successCriteria: string
    completionPct: number
    tasks: { id: string; description: string; status: string }[]
  }
  /**
   * Token usage accumulated across every real LLM call this turn made (can be more than one:
   * decomposition, plan-building, up to maxSteps tool-loop round trips).
   * Absent when the backend/response never reported usage at all (e.g. the claude-cli backend
   * with no usage field) — same "absent when unused" convention as trace/sources. Never set on
   * needs_approval/escalated, matching how trace/sources already behave.
   */
  usage?: TokenUsage
  /** Set when the Contradiction layer flagged a conflict with an existing belief this turn — see assistant-session.ts's findContradictionNotice doc comment for why this is a separate field instead of folded into `reply`. */
  contradictionNotice?: string
  /**
   * An epistemic-honesty signal for replies that went through the harness loop (absent on the
   * triviality fast path, same "absent when unused" convention as trace/sources — a
   * harness-skipped reply has no verification/evidence trail to attach). See answer-claim.ts's
   * doc comment for how each field is derived.
   */
  answerClaim?: AnswerClaim
  /**
   * Set only on a plan-pacing pause — the "Ready to continue with: ...?"/"All plan steps have
   * run..." text appended to `reply` after the model's own draftReply. A caller that streamed
   * `reply` token-by-token via `onToken` (see TurnOptions.onToken) already showed draftReply
   * live and must print this separately, since draftReply is all `onToken` ever saw — this text
   * is computed after the harness run completes, well after streaming finished.
   */
  pausedNote?: string
}

export interface AssistantProgress {
  stepsUsed: number
  maxSteps: number
  currentNode?: string
  /** Live, mid-run position within a durable plan — set only while a plan is actually driving this turn. Absent for an ad hoc single-task/decomposed turn, same "absent when unused" convention as AssistantTurnResult.planStatus. */
  planPosition?: PlanPosition
}
