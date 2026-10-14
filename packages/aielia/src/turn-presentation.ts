import type { AskQuestion } from '@buildaharness/harness'
import type { AssistantTurnResult } from './assistant-types.js'
import type { NextStepSuggestion } from './next-step-proposer.js'
import { FAST_PATH_REASON } from './run-explain.js'

/**
 * What to show for a finished turn, decided once for every surface. The CLI prints it and chat-ui renders it as
 * cards; neither re-reads the status branches of AssistantTurnResult. Hints are data, not formatted strings,
 * because the CLI prints them inline and the apps render them as elements.
 */

export const DEFAULT_APPROVAL_REASON = 'This action needs approval.'
export const DEFAULT_ESCALATION_REASON = 'Aielia halted and needs more information.'
export const DEFAULT_CLARIFICATION_REASON = 'This request needs clarification.'
export const MISSING_PLAN_APPROVAL_ID_REASON = 'A plan is awaiting approval, but its approval id is missing.'

type PendingActionKind = NonNullable<AssistantTurnResult['pendingActionKind']>

const ACTION_LABELS: Record<PendingActionKind, { kindLabel: string; promptText: string }> = {
  write: { kindLabel: 'write', promptText: 'Apply this write?' },
  shell: { kindLabel: 'shell command', promptText: 'Run this command?' },
  email: { kindLabel: 'send email', promptText: 'Send this email?' },
  batch: { kindLabel: 'batch research', promptText: 'Continue?' },
  revert: { kindLabel: 'revert', promptText: 'Apply this revert?' },
}

/** Label and question for a staged action's approval. No kind means a plain write (the original, default pause). */
export function approvalLabels(kind: PendingActionKind | undefined): { kindLabel: string; promptText: string } {
  return ACTION_LABELS[kind ?? 'write']
}

/** The "No harness trace" explanations for /why and /layers, one place so every surface words each case the same. */
export const NO_TRACE = {
  fastPath: FAST_PATH_REASON,
  stagedAction: (kindLabel: string, resolution?: 'approved' | 'declined'): string =>
    resolution
      ? `No harness trace — the last turn was a staged ${kindLabel} that was ${resolution} before the harness ran.`
      : 'No harness trace — the last turn is waiting for your approval before the harness runs.',
  messageApproval: (resolution?: 'approved' | 'declined'): string =>
    resolution === 'declined'
      ? 'No harness trace — the last turn was blocked on an approval gate and declined before the harness ran.'
      : resolution === 'approved'
        ? 'No harness trace — the last turn was approved at the approval gate and has not finished yet.'
        : 'No harness trace — the last turn is waiting for your approval before the harness runs.',
  planApproval: (resolution?: 'approved' | 'declined', pendingHint?: string): string =>
    resolution
      ? `No harness trace — the last turn staged a plan that was ${resolution} before the harness ran.`
      : `No harness trace — the last turn staged a plan for approval${pendingHint ?? ''}.`,
  clarification: (unanswerableReason?: string): string =>
    unanswerableReason !== undefined
      ? `No harness trace — the last turn needed clarification (${unanswerableReason}) but had no answerable questions.`
      : 'No harness trace — the last turn needed clarification before the harness could run.',
  escalated: (reason: string | undefined): string => `No harness trace — the last turn escalated (${reason}) before completing.`,
  stopped: 'No harness trace — the last turn was stopped before it finished.',
  failed: 'No harness trace — the last turn failed with an error.',
} as const

export interface TurnHints {
  /** Number of sources the turn consulted (shown as "N sources — /sources"). */
  sourcesCount?: number
  /** Plan completion, 0–100, when a plan is active. */
  planCompletionPct?: number
  contradictionNotice?: string
  reviewNotice?: string
  auditNotice?: string
  /** Set when a turn was paused part-way; appended after the streamed reply. */
  pausedNote?: string
  nextSteps?: NextStepSuggestion[]
}

export type TurnPresentation =
  | { kind: 'reply'; text: string; riskLevel?: AssistantTurnResult['riskLevel']; hints: TurnHints; noTraceReason?: string }
  | {
      kind: 'approval'
      /** 'action': a staged write/shell/email/batch/revert (resume with pendingActionId). 'message': the message-level risk gate. */
      scope: 'action' | 'message'
      reason: string
      riskLevel?: AssistantTurnResult['riskLevel']
      pendingActionId?: string
      pendingActionKind?: PendingActionKind
      kindLabel?: string
      promptText?: string
      noTraceReason: string
    }
  | { kind: 'clarification'; questions: AskQuestion[]; pendingClarificationId: string; riskLevel?: AssistantTurnResult['riskLevel']; noTraceReason: string }
  | {
      kind: 'plan_approval'
      planApprovalId: string
      /** Absent when the harness staged a plan but did not hand over its tasks; a surface that needs them to render may treat that as an escalation. */
      planApproval?: AssistantTurnResult['planApproval']
      reason?: string
      riskLevel?: AssistantTurnResult['riskLevel']
      noTraceReason: string
    }
  | { kind: 'escalation'; reason: string; noTraceReason: string }
  | { kind: 'cancelled'; noTraceReason: string }

/**
 * Maps a turn result to what every surface shows. `pendingActionId` on the *request* (a resumed staged action)
 * is the surface's business, not this function's: a resumed turn's result is still presented as a reply.
 */
export function presentTurnResult(result: AssistantTurnResult): TurnPresentation {
  switch (result.status) {
    case 'ok':
      return {
        kind: 'reply',
        text: result.reply ?? '',
        riskLevel: result.riskLevel,
        hints: {
          sourcesCount: result.sources && result.sources.length > 0 ? result.sources.length : undefined,
          planCompletionPct: result.planStatus ? result.planStatus.completionPct : undefined,
          contradictionNotice: result.contradictionNotice,
          reviewNotice: result.reviewNotice,
          auditNotice: result.auditNotice,
          pausedNote: result.pausedNote,
          nextSteps: result.nextSteps && result.nextSteps.length > 0 ? result.nextSteps : undefined,
        },
        noTraceReason: result.harnessSkipped ? NO_TRACE.fastPath : undefined,
      }
    case 'cancelled':
      return { kind: 'cancelled', noTraceReason: NO_TRACE.stopped }
    case 'needs_approval': {
      const reason = result.reason ?? DEFAULT_APPROVAL_REASON
      if (result.pendingActionId) {
        const labels = approvalLabels(result.pendingActionKind)
        return {
          kind: 'approval',
          scope: 'action',
          reason,
          riskLevel: result.riskLevel,
          pendingActionId: result.pendingActionId,
          pendingActionKind: result.pendingActionKind,
          ...labels,
          noTraceReason: NO_TRACE.stagedAction(labels.kindLabel),
        }
      }
      return { kind: 'approval', scope: 'message', reason, riskLevel: result.riskLevel, noTraceReason: NO_TRACE.messageApproval() }
    }
    case 'needs_clarification': {
      const questions = result.questions ?? []
      if (questions.length === 0 || !result.pendingClarificationId) {
        // Both are always set together (AskClarificationService), so this fails safe to plain text rather than a card with nothing to ask.
        return {
          kind: 'escalation',
          reason: result.reason ?? DEFAULT_CLARIFICATION_REASON,
          noTraceReason: NO_TRACE.clarification(result.reason ?? 'no further detail'),
        }
      }
      return { kind: 'clarification', questions, pendingClarificationId: result.pendingClarificationId, riskLevel: result.riskLevel, noTraceReason: NO_TRACE.clarification() }
    }
    case 'needs_plan_approval':
      if (!result.planApprovalId) {
        return { kind: 'escalation', reason: result.reason ?? MISSING_PLAN_APPROVAL_ID_REASON, noTraceReason: NO_TRACE.planApproval() }
      }
      return {
        kind: 'plan_approval',
        planApprovalId: result.planApprovalId,
        planApproval: result.planApproval,
        reason: result.reason,
        riskLevel: result.riskLevel,
        noTraceReason: NO_TRACE.planApproval(),
      }
    case 'escalated':
      return { kind: 'escalation', reason: result.reason ?? DEFAULT_ESCALATION_REASON, noTraceReason: NO_TRACE.escalated(result.reason ?? DEFAULT_ESCALATION_REASON) }
  }
}
