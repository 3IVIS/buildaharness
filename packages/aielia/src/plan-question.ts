import type { PlanRecord, PlanTaskRecord } from './plan-store.js'

/**
 * How a message that only asks about the active plan (the classifier's `isPlanQuestion`) is handled:
 * - `stuck` (default): answered from the plan's recorded state ONLY while the plan is stuck on a failed
 *   task — exactly where re-driving the plan is known to go wrong. A healthy plan behaves as it always
 *   has, so this default changes nothing for it.
 * - `always`: any plan question is answered from the recorded state, healthy plan or not.
 * - `off`: an active plan drives every non-trivial turn (the pre-routing behaviour).
 * `AUDIT_PLAN_QUESTION_ROUTING`: `always`/`on`/`1`/`true` → always; `0`/`false`/`off`/`no`/`disabled` → off;
 * empty or `stuck` → stuck. Read at exactly one site: assistant.ts, where the turn is routed.
 */
export type PlanQuestionRouting = 'off' | 'stuck' | 'always'

export function planQuestionRoutingMode(env?: Record<string, string | undefined>): PlanQuestionRouting {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_PLAN_QUESTION_ROUTING ?? '').trim().toLowerCase()
  if (['0', 'false', 'off', 'no', 'disabled'].includes(raw)) return 'off'
  if (['always', 'on', '1', 'true', 'enabled'].includes(raw)) return 'always'
  return 'stuck'
}

/** A plan is stuck when a step failed and was not skipped: the harness cannot advance past it on its own. */
export function isPlanStuck(plan: PlanRecord): boolean {
  return plan.tasks.some((t) => t.status === 'FAILED' && !t.cancelled)
}

export function shouldRoutePlanQuestion(input: { mode: PlanQuestionRouting; plan: PlanRecord | null; isPlanQuestion: boolean | undefined }): boolean {
  const { mode, plan, isPlanQuestion } = input
  if (!plan || isPlanQuestion !== true || mode === 'off') return false
  return mode === 'always' || isPlanStuck(plan)
}

/**
 * The plan's tasks as the harness should see them for a turn that moves the plan forward. A step that
 * failed is put back to pending so it gets another attempt (left as FAILED it would strand the run on
 * every later turn), and its description carries why the last attempt was rejected so the retry can
 * address that instead of repeating it. Only the harness's copy changes: the stored plan keeps its
 * original description, and its status is rewritten from the run's outcome afterwards.
 */
export function planTasksForRun(tasks: PlanTaskRecord[]): PlanTaskRecord[] {
  return tasks.map((t) => {
    if (t.status !== 'FAILED' || t.cancelled) return t
    const why = t.statusNote ? ` (the previous attempt was not accepted: ${t.statusNote})` : ' (retrying a step that failed)'
    return { ...t, status: 'PENDING', description: `${t.description}${why}` }
  })
}

/**
 * What to add to the reply of a turn that ran an approved plan and stopped because a step was not
 * accepted as done. Without it the reply is just the last step that DID complete, and the user only finds
 * out the plan stalled by asking. Empty when nothing was rejected this turn.
 */
export function renderPlanStopNote(plan: PlanRecord, taskNotes: Record<string, string> | undefined): string {
  const lines = plan.tasks
    .filter((t) => !t.cancelled && taskNotes?.[t.id])
    .map((t) => `- ${t.description}: ${taskNotes![t.id]}`)
  if (lines.length === 0) return ''
  return (
    `\n\n---\nI stopped the plan here: ${lines.length === 1 ? 'this step was' : 'these steps were'} not accepted as done.\n` +
    `${lines.join('\n')}\n` +
    `You can tell me to retry ${lines.length === 1 ? 'it' : 'them'} (with more detail if you have it), skip ${lines.length === 1 ? 'that step' : 'those steps'}, or abandon the plan.`
  )
}

const STATUS_LABEL: Record<string, string> = {
  COMPLETE: 'done',
  RUNNING: 'in progress',
  PENDING: 'not started',
  FAILED: 'FAILED',
  BLOCKED: 'blocked',
}

/**
 * The plan's real state, rendered for the prompt of a turn that only asks about it. Grounds the answer
 * in what the task graph actually recorded (a task is "done" only if it completed; a failed one carries
 * the reason it was not accepted) so the reply can't drift into describing the plan as it was drafted.
 */
export function renderPlanStateBlock(plan: PlanRecord): string {
  const lines = plan.tasks.map((t) => {
    const status = t.cancelled ? 'cancelled' : (STATUS_LABEL[t.status] ?? String(t.status).toLowerCase())
    const why = t.statusNote ? ` — not accepted because: ${t.statusNote}` : ''
    return `- [${status}] ${t.description}${why}`
  })
  const done = plan.tasks.filter((t) => t.status === 'COMPLETE' && !t.cancelled).length
  const counted = plan.tasks.filter((t) => !t.cancelled).length
  const stuckHint = isPlanStuck(plan)
    ? `\nA step failed, so the plan is stuck there. Say so, and offer the user their options: retry it (optionally with more detail from them), skip that step, or abandon the plan.`
    : ''
  return (
    `\n\nThe user has an active plan and is only asking about it — do not run or continue it, and do not ` +
    `claim any step is finished unless it is marked done below. Answer from this recorded state.\n` +
    `Plan goal (success criteria): ${plan.successCriteria}\n` +
    `Progress: ${done} of ${counted} steps done.\n` +
    `Steps:\n${lines.join('\n')}${stuckHint}\n` +
    `Nothing runs until the user tells you to continue.`
  )
}
