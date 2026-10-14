import { approvalLabels, NO_TRACE, type AssistantTurnResult, type GoalGraphState, type MemoryInjection, type TurnExplainInput } from '@buildaharness/aielia'
import type { ChatEntry } from './types'

/**
 * What /why, /layers, /sources, /steps and /plan explain: the most recent turn on screen, in the shape the shared
 * explainers (run-explain.ts) take. When a turn ended before the harness ran (staged, declined, escalated,
 * clarification), the reason there is no trace comes from NO_TRACE (turn-presentation.ts), the same words the CLI uses.
 */
export function explainInputFromEntries(
  entries: readonly ChatEntry[],
  extras: { memoryInjection?: MemoryInjection; planStatus?: AssistantTurnResult['planStatus']; goalGraph?: GoalGraphState } = {},
): TurnExplainInput {
  const last = [...entries].reverse().find((e) => e.kind !== 'user' && e.kind !== 'explain')
  const base: TurnExplainInput = { memoryInjection: extras.memoryInjection, planStatus: extras.planStatus, goalGraph: extras.goalGraph }
  if (!last) return base
  switch (last.kind) {
    case 'assistant':
      return {
        trace: last.trace,
        harnessSkipped: last.harnessSkipped,
        answerClaim: last.answerClaim,
        sources: last.sources,
        toolSteps: last.toolSteps,
        planStatus: extras.planStatus ?? last.planStatus,
        goalGraph: extras.goalGraph,
        memoryInjection: last.memoryInjection ?? extras.memoryInjection,
      }
    case 'approval': {
      const resolution = last.resolution ? (last.resolution === 'approved' ? 'approved' : 'declined') : undefined
      return { ...base, noTraceReason: last.pendingActionId ? NO_TRACE.stagedAction(approvalLabels(last.pendingActionKind).kindLabel, resolution) : NO_TRACE.messageApproval(resolution) }
    }
    case 'plan_approval':
      return { ...base, noTraceReason: NO_TRACE.planApproval(last.resolution ? (last.resolution === 'declined' ? 'declined' : 'approved') : undefined) }
    case 'clarification':
      return { ...base, noTraceReason: NO_TRACE.clarification() }
    case 'escalation':
      return { ...base, noTraceReason: NO_TRACE.escalated(last.reason) }
    case 'stopped':
      return { ...base, noTraceReason: NO_TRACE.stopped }
    case 'error':
      return { ...base, noTraceReason: NO_TRACE.failed }
  }
}
