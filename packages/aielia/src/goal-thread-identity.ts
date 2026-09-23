import type { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime'
import { matchGoalIdentity } from './goal-identity-matcher.js'
import { loadGoalGraphRecord, saveGoalGraphRecord, createEmptyGoalGraphRecord, type GoalGraphFsPersistence } from './goal-graph-store.js'
import { focusThread, startThread } from './goal-thread-scheduler.js'

/**
 * Cross-turn goal identity, wired into the turn (plans/hierarchical_goal_tree_and_steering_plan.html
 * Phase 2's matcher, unused until now): decides which goal thread a full turn belongs to, so a
 * message that continues an earlier goal gets that goal's thread back in focus (with its paused
 * evidence intact) and a message about something new starts its own thread. This is what makes
 * the graph fill in for ordinary conversation; before it, threads only came from a session plan or
 * a NEW_GOAL steering message.
 *
 *  - candidates: every thread that is not finished (READY / ACTIVE / PAUSED / BLOCKED — including a
 *    placeholder a NEW_GOAL steering message minted, which is how that deferred ask finds its
 *    thread again when it runs as its own turn). DONE and ABANDONED goals are not reopened.
 *  - matched → `focusThread` (the Scheduler's single write path, INV-39); a BLOCKED match keeps
 *    its status but is still the thread this turn's evidence lands on.
 *  - no match or ambiguous → `startThread`. Ambiguity is never guessed into an attachment
 *    (same fail-safe as the matcher: a missed match costs an extra thread, a wrong one costs work
 *    landing on the wrong goal).
 *  - no candidates → `startThread` with no LLM call at all.
 *
 * Best-effort by construction: any failure (memory, matcher) resolves to "no thread" for this turn,
 * exactly as if the goal graph were off. Returns the thread id this turn's evidence should land on.
 */
export async function resolveTurnGoalThread(params: {
  userMessage: string
  sessionId: string
  memory: MemoryAdapter
  llmClient: ILLMClient
  model?: string
  onUsage?: (usage: TokenUsage) => void
  fsPersistence?: GoalGraphFsPersistence
}): Promise<string | undefined> {
  const { userMessage, sessionId, memory, llmClient, model, onUsage, fsPersistence } = params
  try {
    const record = (await loadGoalGraphRecord(memory, sessionId, fsPersistence)) ?? createEmptyGoalGraphRecord()
    const open = record.threads.filter((t) => t.status !== 'DONE' && t.status !== 'ABANDONED')

    if (open.length > 0) {
      const match = await matchGoalIdentity(userMessage, open.map((t) => ({ id: t.id, description: t.successCriteria })), llmClient, model, onUsage)
      if (match.matchedGoalId) {
        const focused = focusThread(record, match.matchedGoalId)
        if (focused.switched) await saveGoalGraphRecord(memory, sessionId, focused.record, fsPersistence)
        return match.matchedGoalId
      }
    }

    const started = startThread(record, userMessage)
    await saveGoalGraphRecord(memory, sessionId, started.record, fsPersistence)
    return started.activeThreadId ?? undefined
  } catch {
    return undefined
  }
}
