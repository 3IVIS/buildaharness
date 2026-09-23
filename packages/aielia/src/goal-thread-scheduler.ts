import type { GoalGraphRecord, GoalThread } from './goal-graph-store.js'
import { getActiveThread, readyThreads } from './goal-graph-store.js'

/**
 * Phase 5 of plans/hierarchical_goal_tree_and_steering_plan.html — the Scheduler: the sole writer
 * of `GoalGraphRecord.activeThreadId` (INV-39), enforcing single-focus v1 (INV-38 — at most one
 * `ACTIVE` thread at a time) and READY-only selection that excludes anything mid-Tier-2-drafting
 * (INV-40, via `readyThreads()`'s own `status`+`mode` filter).
 *
 * Per the plan's resolved "ACTIVE-pointer write authority" decision, IMMEDIATE and DEFERRED
 * steering both call this *same* selection function with the *same* exclusion rules — the only
 * difference is *when* a caller invokes it: `goal-graph-reconcile.ts`'s NEW_GOAL branch calls it
 * synchronously, this same iteration, for IMMEDIATE; DEFERRED leaves it for the next natural pass
 * (today, `assistant.ts`'s own per-turn call at turn-dispatch, gated on `options.steeringChannel`
 * being present — the natural turn-scoped analog of "off a control_state BLOCKED trigger", since
 * TaskGraph loading/swapping is itself a turn-scoped operation, not a mid-iteration one).
 */
export interface SchedulerSelectionResult {
  record: GoalGraphRecord
  activeThreadId: string | null
  switched: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

/** FIFO fairness among eligible candidates — the thread that's been waiting READY the longest goes next. */
function pickFifo(candidates: GoalThread[]): GoalThread {
  return [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
}

/**
 * Builds the record that results from promoting `next` to `ACTIVE`, defensively demoting any
 * other thread still marked `ACTIVE` to `PAUSED` first (INV-38 — single-focus is enforced by
 * construction here, not assumed of the input).
 */
function activate(record: GoalGraphRecord, next: GoalThread): GoalGraphRecord {
  const stamp = nowIso()
  const threads = record.threads.map((t) => {
    if (t.id === next.id) return { ...t, status: 'ACTIVE' as const, updatedAt: stamp }
    if (t.status === 'ACTIVE') return { ...t, status: 'PAUSED' as const, updatedAt: stamp }
    return t
  })
  return { ...record, threads, activeThreadId: next.id, updatedAt: stamp }
}

/**
 * The Scheduler's one selection pass. If a thread is already genuinely `ACTIVE`
 * (`getActiveThread` — defensively re-checks `status`, not just the pointer), it keeps focus:
 * v1 is cooperative, not preemptive by default (Q6) — a still-workable ACTIVE thread is never
 * bumped just because other READY threads exist. Only when there is *no* valid ACTIVE thread
 * (null pointer, or the pointed-at thread's own status has moved on — PAUSED/BLOCKED/DONE/
 * ABANDONED, e.g. after a NEW_GOAL/CANCEL_CURRENT steering event paused or abandoned it) does it
 * pick the next eligible candidate, FIFO by `createdAt`. No eligible candidate leaves the pointer
 * exactly as it was — never invents a switch out of thin air.
 */
export function selectActiveThread(record: GoalGraphRecord): SchedulerSelectionResult {
  const current = getActiveThread(record)
  if (current) {
    return { record, activeThreadId: current.id, switched: false }
  }
  const candidates = readyThreads(record)
  if (candidates.length === 0) {
    return { record, activeThreadId: record.activeThreadId, switched: false }
  }
  const next = pickFifo(candidates)
  return { record: activate(record, next), activeThreadId: next.id, switched: true }
}

/**
 * IMMEDIATE steering's synchronous hook (see the header comment): forces `threadId` to become
 * `ACTIVE` right now if — and only if — it's actually eligible (`READY`, not mid-drafting) per the
 * exact same rules `selectActiveThread` itself enforces. An ineligible or unknown `threadId` (e.g.
 * the just-minted thread is still `mode: 'drafting'`, per `mintConcurrentReadyThread` — real,
 * common case: Tier-2 hasn't decomposed it into runnable tasks yet) falls back to the ordinary
 * `selectActiveThread` pass rather than force-activating something not actually runnable —
 * "same selection function, same exclusion rules either way" holds even for the forced path.
 */
export function forceActivateThread(record: GoalGraphRecord, threadId: string): SchedulerSelectionResult {
  const target = record.threads.find((t) => t.id === threadId)
  const eligible = target && readyThreads(record).some((t) => t.id === threadId)
  if (!eligible || !target) {
    return selectActiveThread(record)
  }
  if (getActiveThread(record)?.id === target.id) {
    return { record, activeThreadId: target.id, switched: false }
  }
  return { record: activate(record, target), activeThreadId: target.id, switched: true }
}

/**
 * Gives `threadId` focus for the turn that is about to run on it — the identity matcher's "this
 * message continues that goal" outcome. Unlike `forceActivateThread` (which only ever activates a
 * thread the Scheduler already considers eligible), this is the deliberate, user-driven switch:
 * the message itself is the evidence, so a READY, PAUSED or still-drafting thread is promoted
 * (a drafting thread — e.g. one a NEW_GOAL steering message minted — becomes `mode: 'active'`,
 * because a real turn is now executing it) and whatever else was ACTIVE is paused with its
 * evidence intact (INV-42). Still the Scheduler's single write path to the ACTIVE pointer (INV-39).
 * A BLOCKED, DONE, ABANDONED or already-ACTIVE thread is left exactly as it is (`switched: false`):
 * blocked work isn't silently unblocked by a mention, and finished work isn't reopened.
 */
export function focusThread(record: GoalGraphRecord, threadId: string): SchedulerSelectionResult {
  const target = record.threads.find((t) => t.id === threadId)
  if (!target) return { record, activeThreadId: record.activeThreadId, switched: false }
  if (getActiveThread(record)?.id === target.id) return { record, activeThreadId: target.id, switched: false }
  if (target.status !== 'READY' && target.status !== 'PAUSED') return { record, activeThreadId: record.activeThreadId, switched: false }
  const adopted: GoalGraphRecord = {
    ...record,
    threads: record.threads.map((t) => (t.id === target.id && (t.mode === 'drafting' || t.mode === 'awaiting_approval') ? { ...t, mode: 'active' as const } : t)),
  }
  return { record: activate(adopted, adopted.threads.find((t) => t.id === target.id) as GoalThread), activeThreadId: target.id, switched: true }
}

/**
 * Starts a brand-new goal thread that takes focus immediately — the identity matcher's "this is a
 * new goal" outcome (no existing thread matches, or it was ambiguous). The description is the
 * message itself, kept to one short line. Any thread that was ACTIVE is paused and linked as a
 * `concurrent` sibling (R3), never discarded (INV-42). `tasks` starts empty and is adopted from the
 * harness's task graph once the turn runs (see syncThreadFromTaskGraph).
 */
export function startThread(record: GoalGraphRecord, description: string): SchedulerSelectionResult {
  const now = nowIso()
  const id = crypto.randomUUID()
  const summary = description.replace(/\s+/g, ' ').trim().slice(0, 200)
  const pausedId = getActiveThread(record)?.id ?? null
  const fresh: GoalThread = {
    id,
    status: 'ACTIVE',
    relationToSiblings: pausedId ? 'concurrent' : undefined,
    siblingIds: pausedId ? [pausedId] : undefined,
    templateName: null,
    successCriteria: summary,
    rationale: summary,
    tasks: [],
    mode: 'active',
    executingOnPlan: false,
    createdAt: now,
    updatedAt: now,
  }
  const threads = record.threads.map((t) => {
    if (t.id === pausedId) return { ...t, status: 'PAUSED' as const, relationToSiblings: 'concurrent' as const, siblingIds: [...(t.siblingIds ?? []), id], updatedAt: now }
    if (t.status === 'ACTIVE') return { ...t, status: 'PAUSED' as const, updatedAt: now }
    return t
  })
  return { record: { ...record, threads: [...threads, fresh], activeThreadId: id, updatedAt: now }, activeThreadId: id, switched: true }
}

/**
 * INV-42 (Q3's resolution — "PAUSED preserves partial state/evidence — never silently discarded
 * on preemption"): the per-thread analog of `plan-store.ts`'s `updatePlanFromRun`, mapping the
 * harness's resulting task statuses back onto `threadId`'s own `tasks` list. Deliberately looked
 * up **by id**, not via `getActiveThread` — the whole point is this still works for a thread the
 * Scheduler has since moved to `PAUSED` (an in-flight tool call that was already running when a
 * steering message preempted its thread runs to completion per Q3's "let it finish" default, and
 * its result must still land on the now-PAUSED thread, not be silently dropped). A `threadId` not
 * present in `record.threads` is a no-op — defensive, never throws on a stale id.
 */
export function syncThreadFromTaskGraph(
  record: GoalGraphRecord,
  threadId: string,
  taskGraphTasks: { id: string; status: GoalThread['tasks'][number]['status']; description?: string; depends_on?: string[]; risk_level?: 'LOW' | 'MEDIUM' | 'HIGH' }[],
): GoalGraphRecord {
  const statusById = new Map(taskGraphTasks.map((t) => [t.id, t.status === 'RUNNING' ? ('PENDING' as const) : t.status]))
  const stamp = nowIso()
  const threads = record.threads.map((t) => {
    if (t.id !== threadId) return t
    // A thread started by the identity matcher has no tasks of its own yet — it takes the ones the
    // harness actually ran this turn, so it can be tracked to completion (and reach DONE) like any
    // plan-derived thread. A thread that already has tasks (a plan's) keeps its own list.
    const adopted: GoalThread['tasks'] =
      t.tasks.length === 0 && t.mode !== 'drafting'
        ? taskGraphTasks.map((task) => ({ id: task.id, description: task.description ?? task.id, depends_on: task.depends_on ?? [], status: statusById.get(task.id) ?? task.status, ...(task.risk_level ? { riskLevel: task.risk_level } : {}) }))
        : t.tasks
    const tasks = adopted.map((task) => ({ ...task, status: statusById.get(task.id) ?? task.status }))
    // A thread is DONE once every task that still counts (not cancelled) is COMPLETE. Nothing else
    // ever moved a thread to DONE at runtime, so without this a thread could finish all its work
    // and stay ACTIVE/PAUSED forever — and the next-step proposer (which only fires on the
    // transition to DONE) could never run. An empty task list is *not* done (nothing was done),
    // and an already-DONE/ABANDONED thread is left exactly as it is.
    const counted = tasks.filter((task) => !task.cancelled)
    const finished = counted.length > 0 && counted.every((task) => task.status === 'COMPLETE')
    if (finished && t.status !== 'DONE' && t.status !== 'ABANDONED') {
      return { ...t, tasks, status: 'DONE' as const, mode: 'done' as const, updatedAt: stamp }
    }
    return { ...t, tasks, updatedAt: stamp }
  })
  return { ...record, threads, updatedAt: stamp }
}
