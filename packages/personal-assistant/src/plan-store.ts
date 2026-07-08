import type { MemoryAdapter, ILLMClient, TokenUsage } from '@buildaharness/runtime'
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

// Deliberately looser than ABANDON_PHRASES — only decides whether a message worth an extra
// LLM-backed look for a paraphrased abandon request, not a verdict itself. A plan can run
// for many turns, and most of those are routine progress-check turns ("give me an update",
// "what's next") that must never spend an extra call just because a plan happens to be
// active — this keeps the LLM fallback scoped to turns that actually look like they might
// be trying to stop the plan.
const ABANDON_SHAPE = /\b(stop|cancel|quit|drop|skip|pause|scrap|kill (this|the)|don'?t (need|want)|no longer (need|want))\b/i

export function looksLikeAbandonAttempt(message: string): boolean {
  return ABANDON_SHAPE.test(message)
}

const ABANDON_SCHEMA = {
  type: 'object',
  properties: { abandon: { type: 'boolean' } },
  required: ['abandon'],
}

const ABANDON_SYSTEM_PROMPT =
  'The user has an active multi-step plan running. Decide whether their latest message is asking to ' +
  'abandon, cancel, or scrap that plan entirely — as opposed to a question about it, a tweak to one of its ' +
  "tasks, or an unrelated aside. Respond with JSON only: {\"abandon\": boolean}"

/**
 * Second opinion for a message isAbandonPhrase's fixed phrase list didn't match but
 * looksLikeAbandonAttempt flagged as worth double-checking (see assistant.ts) — gated the
 * same way risk-classifier.ts's classifyRiskWithLLM is, so a plan's routine progress-check
 * turns never pay for this. Falls back to `false`
 * (don't abandon) on any parse failure or LLM error — losing an abandon signal just means the
 * user has to say it more plainly next turn, safer than abandoning an active plan by mistake.
 */
export async function isAbandonPhraseWithLLM(message: string, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<boolean> {
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: ABANDON_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: ABANDON_SCHEMA } },
    )
    const parsed = JSON.parse(response.content) as { abandon?: unknown }
    return parsed.abandon === true
  } catch {
    return false
  }
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
    ...plan.tasks.map((t) => `  ${STATUS_ICON[t.status]} [${t.status}] ${t.id} — ${t.description}`),
    '',
    `Success criteria: ${plan.successCriteria}`,
  ]
  return lines.join('\n')
}
