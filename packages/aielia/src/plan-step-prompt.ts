/**
 * `AUDIT_PLAN_STEP_PROMPT` gate. Default **ON**: while an approved plan runs, the model is told which
 * step it is carrying out. A falsy value (`0` / `false` / `off` / `no` / `disabled`) restores the
 * previous behaviour, where every step was run by re-sending the user's message alone. Read at exactly
 * one site: assistant.ts, where the proposer is wired.
 */
export function planStepPromptEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_PLAN_STEP_PROMPT ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * The instruction that makes one step of a plan a distinct piece of work. Without it the harness ran
 * every step through the same proposer with only the user's message ("run the plan"), so each step
 * produced the same answer and none of them did its own step. `description` may already carry the
 * reason a previous attempt was rejected (plan-question.ts's planTasksForRun), which is what lets a
 * retry address it.
 */
export function buildStepInstruction(description: string): string {
  return (
    `[plan step] You are now carrying out ONE step of the user's approved plan: "${description}".\n` +
    `Do this step now and produce its actual result — the deliverable, decision or action it calls for. ` +
    `Do not answer the user's whole request again, do not re-plan, and treat any earlier step in this ` +
    `conversation as already handled. If you genuinely cannot do this step (information or access you ` +
    `lack), say exactly what is missing instead of pretending it is done.`
  )
}
