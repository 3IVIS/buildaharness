import type { ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime'
import { AsyncFnUpdateChannel, type UpdateChannel } from '@buildaharness/harness'
import { LiveSteeringChannel, type SteeringEvent } from './live-steering-channel.js'
import { classifyScopeUrgency } from './scope-urgency-classifier.js'
import {
  loadGoalGraphRecord,
  saveGoalGraphRecord,
  createEmptyGoalGraphRecord,
  getActiveThread,
  mintConcurrentReadyThread,
  abandonThread,
  type GoalGraphFsPersistence,
} from './goal-graph-store.js'
import { forceActivateThread } from './goal-thread-scheduler.js'

/**
 * Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html — the Tier-1 reconcile pass that
 * turns a drained LiveSteeringChannel (Phase 3) into a handled ask via the scope×urgency
 * classifier. One message is classified per poll() — checkCallerUpdates polls once per harness
 * iteration, so a backlog of several queued messages drains one per iteration rather than all at
 * once.
 *
 * Every classified message ends in exactly one of two places — never dropped (R4):
 *
 *  - **Applied in place** — a *steering note* the running turn's proposer reads before its next
 *    LLM call (`takeNotes()`): SAME_TASK always, SAME_GOAL_NEW_TASK when IMMEDIATE. The model
 *    itself interprets the note. Earlier revisions instead pushed the raw message text into the
 *    harness's `add_constraint` / `add_success_criteria`, which are enforced *lexically*
 *    (output-validation.ts's negation-word rule, criterionCovered's token overlap): a correction
 *    like "use the audited figure, not the draft one" then made the reply's own words a
 *    "violation" and threw the whole turn, and a criterion no proposer ever read was never acted
 *    on. Neither field is read by the one-loop proposer's LLM call, so neither can carry a
 *    natural-language ask.
 *  - **Deferred to a follow-up turn** — everything else (NEW_GOAL, SAME_GOAL_NEW_TASK×DEFERRED,
 *    CANCEL_CURRENT's replacement ask) plus any note the proposer never got to read (classified
 *    after its last LLM call). `drainUnconsumed()` returns these so the caller re-enqueues them on
 *    the LiveSteeringChannel, where the caller's post-turn drain (cli.ts / App.tsx) runs each as
 *    an ordinary turn, in arrival order.
 *
 * Goal-graph bookkeeping (NEW_GOAL mints a thread, CANCEL_CURRENT abandons the active one and
 * blocks the task graph via `cancel_current`) is unchanged — INV-39: never writes the ACTIVE
 * pointer except through the Scheduler's own forceActivateThread.
 */
export interface SteeringReconcileChannel {
  channel: UpdateChannel
  /**
   * Steering notes classified since the last call, for the proposer to fold into its next LLM
   * call. Each is returned once and counted as applied — call it only when about to make that call.
   */
  takeNotes(): string[]
  /**
   * Everything that must still be run as a follow-up turn: deferred asks, notes the proposer never
   * took, and messages never classified at all (the harness run ended before its next poll). The
   * caller re-enqueues these onto the original LiveSteeringChannel (R4).
   */
  drainUnconsumed(): SteeringEvent[]
}

export function createSteeringReconcileChannel(params: {
  steeringChannel: LiveSteeringChannel
  sessionId: string
  memory: MemoryAdapter
  llmClient: ILLMClient
  model?: string
  onUsage?: (usage: TokenUsage) => void
  fsPersistence?: GoalGraphFsPersistence
}): SteeringReconcileChannel {
  const { steeringChannel, sessionId, memory, llmClient, model, onUsage, fsPersistence } = params
  let buffer: SteeringEvent[] = []
  let pendingNotes: SteeringEvent[] = []
  const deferred: SteeringEvent[] = []

  const channel = new AsyncFnUpdateChannel(async () => {
    buffer.push(...steeringChannel.poll())
    const next = buffer.shift()
    if (!next) return null

    const goalGraph = (await loadGoalGraphRecord(memory, sessionId, fsPersistence)) ?? createEmptyGoalGraphRecord()
    const activeThread = getActiveThread(goalGraph)

    const classification = await classifyScopeUrgency(
      next.message,
      { currentGoalDescription: activeThread?.successCriteria ?? null },
      llmClient,
      model,
      onUsage,
    )

    switch (classification.scopeRelation) {
      case 'SAME_TASK':
        // Corrects/refines what's in flight (always IMMEDIATE — see scope-urgency-classifier.ts):
        // the proposer applies it to this turn's own answer.
        pendingNotes.push(next)
        return null

      case 'SAME_GOAL_NEW_TASK':
        // IMMEDIATE: fold into the answer being produced now. DEFERRED (also the INV-41 fail-safe
        // default): wait for the current task to finish, then run as its own turn.
        if (classification.urgency === 'IMMEDIATE') pendingNotes.push(next)
        else deferred.push(next)
        return null

      case 'NEW_GOAL': {
        // Tier-1 never writes the ACTIVE pointer itself (INV-39): both urgencies pause the current
        // thread and mint a new READY one; the Scheduler decides what runs next. IMMEDIATE calls
        // its selection pass synchronously so the new thread can become ACTIVE this iteration if
        // eligible; DEFERRED leaves it queued. Either way the ask itself is also deferred to a
        // follow-up turn — the minted thread is bookkeeping, and a `drafting` thread is never
        // Scheduler-selectable (INV-40), so nothing else would ever run it.
        const minted = mintConcurrentReadyThread(goalGraph, next.message, activeThread?.id ?? null)
        const newThreadId = minted.threads.find((t) => !goalGraph.threads.some((old) => old.id === t.id))?.id
        const updated = classification.urgency === 'IMMEDIATE' && newThreadId ? forceActivateThread(minted, newThreadId).record : minted
        await saveGoalGraphRecord(memory, sessionId, updated, fsPersistence)
        deferred.push(next)
        return null
      }

      case 'CANCEL_CURRENT': {
        if (activeThread) {
          const updated = abandonThread(goalGraph, activeThread.id)
          await saveGoalGraphRecord(memory, sessionId, updated, fsPersistence)
        }
        // The message usually also carries what the user wants instead ("never mind — just tell me
        // the title"), so it runs as the next turn once the cancelled one stops.
        deferred.push(next)
        return { pending_update: { cancel_current: true }, constraints_changed: true }
      }
    }
  })

  return {
    channel,
    takeNotes: () => {
      const taken = pendingNotes
      pendingNotes = []
      return taken.map((e) => e.message)
    },
    drainUnconsumed: () => {
      const remaining = [...pendingNotes, ...deferred, ...buffer].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      pendingNotes = []
      deferred.length = 0
      buffer = []
      return remaining
    },
  }
}
