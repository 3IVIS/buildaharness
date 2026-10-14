import type { AssistantTurnResult, MemoryInjection, TurnExplainInput } from '@buildaharness/aielia'
import type { ChatEntry } from './types'

/**
 * What /why, /layers, /sources, /steps and /plan explain: the most recent turn on screen. Mirrors the
 * CLI, which remembers the last turn's trace and, when a turn ended before the harness ran (staged,
 * declined, escalated, clarification), a specific reason there is no trace.
 */
export function explainInputFromEntries(
  entries: readonly ChatEntry[],
  extras: { memoryInjection?: MemoryInjection; planStatus?: AssistantTurnResult['planStatus'] } = {},
): TurnExplainInput {
  const last = [...entries].reverse().find((e) => e.kind !== 'user' && e.kind !== 'explain')
  const base: TurnExplainInput = { memoryInjection: extras.memoryInjection, planStatus: extras.planStatus }
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
        memoryInjection: last.memoryInjection ?? extras.memoryInjection,
      }
    case 'approval':
      return { ...base, noTraceReason: last.resolution
        ? `No harness trace — the last turn was a staged action that was ${last.resolution === 'approved' ? 'approved' : 'declined'} before the harness ran.`
        : 'No harness trace — the last turn is waiting for your approval before the harness runs.' }
    case 'plan_approval':
      return { ...base, noTraceReason: last.resolution
        ? `No harness trace — the last turn staged a plan that was ${last.resolution === 'declined' ? 'declined' : 'approved'} before the harness ran.`
        : 'No harness trace — the last turn staged a plan for approval.' }
    case 'clarification':
      return { ...base, noTraceReason: 'No harness trace — the last turn needed clarification before the harness could run.' }
    case 'escalation':
      return { ...base, noTraceReason: `No harness trace — the last turn escalated (${last.reason}) before completing.` }
    case 'stopped':
      return { ...base, noTraceReason: 'No harness trace — the last turn was stopped before it finished.' }
    case 'error':
      return { ...base, noTraceReason: 'No harness trace — the last turn failed with an error.' }
  }
}
