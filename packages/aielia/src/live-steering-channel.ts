/**
 * R1 (mid-task steering) of plans/hierarchical_goal_tree_and_steering_plan.html — a message sent
 * while a turn is already running is absorbed here instead of waiting for the CLI's
 * `dispatchQueue` or chat-ui's disabled composer to free up (see Figure 1 of that plan). One
 * instance per session, mirroring `OneShotAnswerChannel`'s per-session lifetime
 * (ask-clarification-service.ts) but with a different shape: that channel resumes a *paused* run
 * with exactly one answer, this one accumulates zero or more raw steering messages while a turn
 * keeps running and hands them all back at once.
 *
 * Phase 3 only builds the queue and the producer-side routing (cli.ts's line-handler split,
 * chat-ui's composer un-disabling) — `poll()` has no consumer yet. Phase 4 wires it into
 * `checkCallerUpdates` via the Scope×Urgency classifier at the harness's own iteration boundary
 * (`UpdateChannel.poll()` in check-caller-updates.ts), turning each drained message into a real
 * `CallerUpdate`. This class is deliberately unaware of `GoalGraphRecord`/`GoalThread` — same
 * "standalone, unused until the wiring phase" discipline `goal-identity-matcher.ts` (Phase 2)
 * already used.
 */
export interface SteeringEvent {
  message: string
  enqueuedAt: number
}

export class LiveSteeringChannel {
  private queue: SteeringEvent[] = []

  enqueue(message: string): void {
    this.queue.push({ message, enqueuedAt: Date.now() })
  }

  /**
   * Drains every event queued since the last poll, oldest first (FIFO) — never partial, never
   * re-delivered: a second call with nothing newly enqueued returns an empty array.
   */
  poll(): SteeringEvent[] {
    const drained = this.queue
    this.queue = []
    return drained
  }

  get pendingCount(): number {
    return this.queue.length
  }
}
