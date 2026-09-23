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

/**
 * Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html — the Tier-1 reconcile pass that
 * turns a drained LiveSteeringChannel (Phase 3) into real CallerUpdates via the scope×urgency
 * classifier, at the harness's own checkCallerUpdates iteration boundary
 * (check-caller-updates.ts's AsyncFnUpdateChannel). One message is classified and emitted per
 * poll() — checkCallerUpdates's RESTART_ITERATION naturally drives one poll per harness iteration,
 * so a backlog of several queued messages drains one per iteration rather than all at once.
 */
export interface SteeringReconcileChannel {
  channel: UpdateChannel
  /**
   * Whatever never got classified/absorbed this turn (the harness run ended — reached DONE, or
   * escalated — before the queue drained) — R4's "never silently drop the new ask" still has to
   * hold once this channel's own closure state is gone. The caller re-enqueues these onto the
   * original LiveSteeringChannel so the existing post-turn fallback drain (cli.ts's dispatchOne
   * `finally`, App.tsx's drainSteeringChannel — both built in Phase 3) picks them up as ordinary
   * follow-up turns, exactly like a steering message sent during a trivial turn that never even
   * calls harnessBridge.run() (and so never reaches this channel's poll() at all).
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
        // Fold into current context — collapses to IMMEDIATE regardless of the classifier's
        // urgency verdict (see scope-urgency-classifier.ts), no task-graph shape change.
        return { pending_update: { add_constraint: next.message }, constraints_changed: true }

      case 'SAME_GOAL_NEW_TASK':
        // Both IMMEDIATE and DEFERRED append a new success criterion here — revalidateTaskGraph
        // (reused as-is) turns an uncovered criterion into a new PENDING task without touching
        // anything already in scope. The IMMEDIATE row's parallel_write_domains conflict check
        // (ordering the new task via depends_on when it actually conflicts) is deferred to Phase
        // 5, which owns the Scheduler/in-flight tool call policy this ordering decision belongs
        // next to — Phase 4 lays the criterion down, Phase 5 decides how it interleaves.
        return { pending_update: { add_success_criteria: [next.message] }, constraints_changed: true }

      case 'NEW_GOAL': {
        // Tier-1 never writes the ACTIVE pointer itself (INV-39 — see the plan's resolved
        // "ACTIVE-pointer write authority" decision): both IMMEDIATE and DEFERRED just pause the
        // current thread and mint a new READY one; Phase 5's Scheduler decides what runs next.
        const updated = mintConcurrentReadyThread(goalGraph, next.message, activeThread?.id ?? null)
        await saveGoalGraphRecord(memory, sessionId, updated, fsPersistence)
        return null
      }

      case 'CANCEL_CURRENT': {
        if (activeThread) {
          const updated = abandonThread(goalGraph, activeThread.id)
          await saveGoalGraphRecord(memory, sessionId, updated, fsPersistence)
        }
        return { pending_update: { cancel_current: true }, constraints_changed: true }
      }
    }
  })

  return {
    channel,
    drainUnconsumed: () => {
      const remaining = buffer
      buffer = []
      return remaining
    },
  }
}
