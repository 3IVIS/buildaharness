import type { MemoryAdapter } from '@buildaharness/runtime'
import type { TaskStatus } from '@buildaharness/harness'
import type { Plan } from './plan-builder.js'

export interface PlanTaskRecord {
  id: string
  description: string
  depends_on: string[]
  status: TaskStatus
}

export interface PlanRecord {
  templateName: string
  successCriteria: string
  tasks: PlanTaskRecord[]
  status: 'active' | 'done' | 'abandoned'
  createdAt: string
  updatedAt: string
}

// A small, fixed set of phrases — same conservative-keyword-gate style as the
// reminder detection in assistant.ts — rather than a second LLM call just to
// detect "the user wants to abandon this."
const ABANDON_PHRASES = [/forget (this|the) plan/i, /start over/i, /never mind the plan/i, /abandon (this|the) plan/i]

export function isAbandonPhrase(message: string): boolean {
  return ABANDON_PHRASES.some((re) => re.test(message))
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

export function planCompletionPct(plan: PlanRecord): number {
  if (plan.tasks.length === 0) return 0
  return (plan.tasks.filter((t) => t.status === 'COMPLETE').length / plan.tasks.length) * 100
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
    ...plan.tasks.map((t) => `  ${STATUS_ICON[t.status]} [${t.status}] ${t.id} — ${t.description}`),
    '',
    `Success criteria: ${plan.successCriteria}`,
  ]
  return lines.join('\n')
}
