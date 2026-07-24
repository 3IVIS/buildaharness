import type { MemoryAdapter } from '@buildaharness/runtime'
import { containsCJK, tokenize, type TaskStatus } from '@buildaharness/harness'
import type { Plan } from './plan-builder.js'
import { getTaskCancelPatterns, testAny } from './lexical/patterns.js'

export interface PlanTaskRecord {
  id: string
  description: string
  depends_on: string[]
  status: TaskStatus
  /**
   * True once the user explicitly cancelled this specific task (see matchTaskCancelAttempt/
   * cancelPlanTask) — distinct from `status`, which gets set to 'COMPLETE' alongside this so the
   * harness's task-graph selection and dependent-unblocking treat it as resolved the same way a
   * genuinely finished task would be (TaskStatus, from @buildaharness/harness, has no CANCELLED
   * value of its own — extending that union is a cross-package change out of scope here).
   * formatPlanProgress/planCompletionPct read this flag to show/count it accurately instead of
   * claiming the user's own work actually got done.
   */
  cancelled?: boolean
}

export interface PlanRecord {
  templateName: string
  successCriteria: string
  tasks: PlanTaskRecord[]
  status: 'active' | 'done' | 'abandoned'
  createdAt: string
  updatedAt: string
}

function planKey(sessionId: string): string {
  return `plan:${sessionId}`
}

/** Returns null when no plan exists for this session, or the stored plan is already done/abandoned — a finished plan never auto-resumes. */
export async function loadActivePlan(memory: MemoryAdapter, sessionId: string): Promise<PlanRecord | null> {
  const record = (await memory.get(planKey(sessionId))) as PlanRecord | undefined
  if (!record || record.status !== 'active') return null
  return record
}

export function createPlanRecord(plan: Plan): PlanRecord {
  const now = new Date().toISOString()
  return {
    templateName: plan.templateName,
    successCriteria: plan.successCriteria,
    tasks: plan.tasks.map((t): PlanTaskRecord => ({ id: t.id, description: t.description, depends_on: t.depends_on, status: 'PENDING' })),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

export async function savePlan(memory: MemoryAdapter, sessionId: string, plan: PlanRecord): Promise<void> {
  await memory.set(planKey(sessionId), plan)
}

export async function abandonPlan(memory: MemoryAdapter, sessionId: string, plan: PlanRecord): Promise<void> {
  await savePlan(memory, sessionId, { ...plan, status: 'abandoned', updatedAt: new Date().toISOString() })
}

export interface TaskCancelMatch {
  taskId: string
  taskDescription: string
}

// Compiled from packages/personal-assistant/src/lexical/patterns/task-cancel-markers.json (see
// lexical/patterns.ts) — the historical rationale below documents this pattern's current shape;
// edit the JSON to change it, not this file.
const { taskCancelVerbs: TASK_CANCEL_VERBS, taskReferenceMarker: TASK_REFERENCE_MARKER, cancelMatchStopwords: CANCEL_MATCH_STOPWORDS } = getTaskCancelPatterns()

// Common words that would spuriously "overlap" with almost any task description if not excluded
// — matchTaskCancelAttempt needs a genuinely distinctive word in common with a task, not just any
// shared word, or "cancel that" / "skip this one" would match the first task in every plan.

// A single shared 4+-letter word is not enough on its own — a genuine, unrelated real-world cancel
// request can coincidentally share a word with an auto-generated task description (e.g. "insurance"
// appears both in a real "cancel my travel insurance policy" request AND a plan's own
// "arrange travel insurance" logistics task). Found via live testing: with an active trip-planning
// plan running, "please cancel my travel insurance policy with my current provider" — a genuine,
// gateable HIGH-risk request the user actually wants acted on — got silently misrouted into
// cancelling the plan's internal logistics_prep bookkeeping task instead, with no approval gate,
// and the real request was never surfaced, gated, or fulfilled at all.
// Requiring the message itself to explicitly reference the PLAN/a TASK/STEP ("cancel that task",
// "skip this step", "drop that part of the plan") — not just any cancel-shaped verb plus a
// coincidentally shared word — keeps this deterministic shortcut scoped to what it was actually
// built for (conv59/conv70's h9: dropping one step of an active plan the user is talking to the
// assistant about), and lets anything else fall through to the ordinary message-level risk gate,
// the same safe default this function already falls back to when no task match is found at all.

/**
 * Detects a request to cancel/skip ONE task within an active plan — distinct from
 * classifyTurnIntent's isAbandonRequest judgment, which is about ending the WHOLE plan (see
 * conv59/conv70's h9 finding: "cancel the daily-budget task" isn't asking to abandon a trip-planning
 * plan entirely, just to drop one of its steps, and there was no feature to route that to at
 * all). Matches a cancel-shaped verb (cancel/skip/drop/remove), an explicit reference to the plan
 * or one of its tasks/steps (TASK_REFERENCE_MARKER), together with a distinctive word (4+ letters,
 * not a common stopword) shared with one of the plan's own not-yet-complete task
 * descriptions/ids — deliberately conservative: a bare "cancel" with no recognizable task
 * reference (e.g. "cancel my gym membership", unrelated to anything in this plan, or "cancel my
 * travel insurance policy with my current provider", a genuine external request that merely
 * happens to share a word with a task description) returns null and falls through to the ordinary
 * message-level risk gate, same as today. Returns the first matching task in plan order, or null.
 */
export function matchTaskCancelAttempt(message: string, plan: PlanRecord): TaskCancelMatch | null {
  if (!testAny(TASK_CANCEL_VERBS, message)) return null
  if (!testAny(TASK_REFERENCE_MARKER, message)) return null
  const lower = message.toLowerCase()
  for (const task of plan.tasks) {
    if (task.status === 'COMPLETE' || task.cancelled) continue
    // tokenize (not a bare `.split(/[^a-z0-9]+/)`) so this works on non-Latin scripts too — that
    // ASCII-only split produced an empty word list for any CJK task description, silently
    // disabling this feature entirely rather than just matching less precisely. The "4+ letters"
    // distinctiveness filter is an English-specific heuristic (a short word is usually a stopword,
    // a longer one usually isn't) that doesn't transfer to CJK, where tokenize splits per
    // character and even a single character is often already distinctive — so that length
    // threshold only applies to non-CJK tokens; a CJK token just needs to not be a stopword.
    const words = tokenize(`${task.id} ${task.description}`.toLowerCase()).filter(
      (w) => !CANCEL_MATCH_STOPWORDS.has(w) && (containsCJK(w) || w.length >= 4),
    )
    if (words.some((w) => lower.includes(w))) {
      return { taskId: task.id, taskDescription: task.description }
    }
  }
  return null
}

/**
 * Cancels one task within an active plan — internal bookkeeping only (see PlanTaskRecord.cancelled
 * for why status becomes 'COMPLETE' alongside the cancelled flag). Unlike abandonPlan, the plan
 * itself stays 'active' so the remaining tasks continue normally.
 */
export async function cancelPlanTask(memory: MemoryAdapter, sessionId: string, plan: PlanRecord, taskId: string): Promise<PlanRecord> {
  const tasks = plan.tasks.map((t): PlanTaskRecord => (t.id === taskId ? { ...t, status: 'COMPLETE', cancelled: true } : t))
  const updated: PlanRecord = { ...plan, tasks, updatedAt: new Date().toISOString() }
  await savePlan(memory, sessionId, updated)
  return updated
}

/**
 * Maps the harness's resulting task statuses back onto the plan's own task list —
 * mirrors what adapter/harness/plan_store.py's task_graph_to_plan does for the
 * Python planner, just keyed to a chat session instead of a snapshot file. Marks
 * the plan 'done' once every task is COMPLETE, so loadActivePlan stops resuming it.
 */
export function updatePlanFromRun(plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): PlanRecord {
  const statusById = new Map(taskGraphTasks.map((t) => [t.id, normalizeRestingStatus(t.status)]))
  const tasks = plan.tasks.map((t): PlanTaskRecord => ({ ...t, status: statusById.get(t.id) ?? t.status }))
  const allComplete = tasks.length > 0 && tasks.every((t) => t.status === 'COMPLETE')
  return {
    ...plan,
    tasks,
    status: allComplete ? 'done' : plan.status,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * RUNNING is a mid-run status only. A task the harness didn't finish before this
 * turn's run() returned (e.g. the step cap was hit mid-task) is not "in progress"
 * across turns — it just needs a fresh attempt next time. Persisting RUNNING as-is
 * would strand it forever: TaskGraph.selectUnblockedLeaf only reselects PENDING
 * tasks, and a dependent only unblocks once its dependency is COMPLETE.
 */
function normalizeRestingStatus(status: TaskStatus): TaskStatus {
  return status === 'RUNNING' ? 'PENDING' : status
}

/** Cancelled tasks are excluded from both sides of the ratio — they're neither remaining work nor
 * something the user actually did, so counting them as "complete" would overstate real progress.
 * A plan with no tasks at all is 0% (unchanged); a plan whose remaining tasks were all cancelled
 * is 100% (nothing left to do) — two different situations, not the same "empty" case. */
export function planCompletionPct(plan: PlanRecord): number {
  if (plan.tasks.length === 0) return 0
  const relevant = plan.tasks.filter((t) => !t.cancelled)
  if (relevant.length === 0) return 100
  return (relevant.filter((t) => t.status === 'COMPLETE').length / relevant.length) * 100
}

/**
 * Live, mid-run position within a durable plan — see the harness layer activation plan's
 * Phase 3.2. `stepIndex` is 1-based: the task currently RUNNING, or (once nothing is running)
 * the last COMPLETE task, or the first task before anything has started.
 */
export interface PlanPosition {
  templateName: string
  stepIndex: number
  stepCount: number
  currentTaskDescription: string
  completionPct: number
}

/** Computes live plan position from a live (possibly mid-run) task-status list — `plan.tasks`' own order is authoritative; `taskGraphTasks` only supplies current status per id. */
export function computePlanPosition(plan: PlanRecord, taskGraphTasks: { id: string; status: TaskStatus }[]): PlanPosition | null {
  if (plan.tasks.length === 0) return null
  const statusById = new Map(taskGraphTasks.map((t) => [t.id, t.status]))

  let idx = plan.tasks.findIndex((t) => statusById.get(t.id) === 'RUNNING')
  if (idx === -1) {
    for (let i = plan.tasks.length - 1; i >= 0; i--) {
      if (statusById.get(plan.tasks[i].id) === 'COMPLETE') { idx = i; break }
    }
  }
  if (idx === -1) idx = 0

  const completedCount = plan.tasks.filter((t) => statusById.get(t.id) === 'COMPLETE').length
  return {
    templateName: plan.templateName,
    stepIndex: idx + 1,
    stepCount: plan.tasks.length,
    currentTaskDescription: plan.tasks[idx].description,
    completionPct: (completedCount / plan.tasks.length) * 100,
  }
}

/** The next not-yet-COMPLETE task in plan order — used to phrase a pause/resume prompt ("Ready to continue with: <description>?"). Returns null once every task is COMPLETE. */
export function nextPendingTask(plan: PlanRecord): PlanTaskRecord | null {
  return plan.tasks.find((t) => t.status !== 'COMPLETE') ?? null
}

const STATUS_ICON: Record<TaskStatus, string> = {
  PENDING: '○',
  RUNNING: '▶',
  COMPLETE: '✓',
  FAILED: '✗',
  BLOCKED: '✗',
  HUMAN_REQUIRED: '~',
}

/** Human-readable plan status — mirrors agents/planner/utils.py's format_plan_progress, for callers (the CLI) that want text instead of the structured planStatus field. */
export function formatPlanProgress(plan: PlanRecord): string {
  const lines = [
    `Plan: ${plan.templateName} (${planCompletionPct(plan).toFixed(1)}% complete)`,
    '',
    'Task statuses:',
    ...plan.tasks.map((t) => `  ${t.cancelled ? '⊘' : STATUS_ICON[t.status]} [${t.cancelled ? 'CANCELLED' : t.status}] ${t.id} — ${t.description}`),
    '',
    `Success criteria: ${plan.successCriteria}`,
  ]
  return lines.join('\n')
}
