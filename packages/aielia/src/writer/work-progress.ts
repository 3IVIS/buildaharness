/**
 * What Write tells the writer while a model call runs in the background: a short checklist for the kind of job, and the sentence for
 * the stage it is at. Pure, so the browser and desktop builds render the same words. The stages are the real boundaries of the work;
 * nothing here cycles on a timer.
 */

export type WorkKind = 'edit' | 'draft' | 'suggest' | 'answer' | 'verify' | 'check' | 'other'

export interface WorkPlan {
  /** The stages of this kind of job, in order, each a phrase for a checklist ("Reading your request"). */
  steps: readonly string[]
}

const PLANS: Record<WorkKind, readonly string[]> = {
  edit: ['Saving your text', 'Reading your request', 'Making the edit'],
  draft: ['Saving your text', 'Reading your request', 'Writing the first draft'],
  suggest: ['Saving your text', 'Reading your request', 'Finding changes to suggest'],
  answer: ['Reading your article', 'Writing the answer'],
  verify: ['Saving your text', 'Finding the claims to check', 'Looking things up', 'Writing up what I found'],
  check: ['Reading the text', 'Finding and checking the claims'],
  other: [],
}

/** The checklist for a kind of job; empty when the job is too short to need one. */
export function workPlan(kind: WorkKind): WorkPlan {
  return { steps: PLANS[kind] }
}

export type StepState = 'done' | 'current' | 'waiting'

export interface ChecklistItem { text: string; state: StepState }

/** The checklist with `current` as the step in progress: earlier ones done, later ones waiting. An index past the end marks all done. */
export function checklistAt(plan: WorkPlan, current: number): ChecklistItem[] {
  return plan.steps.map((text, i) => ({ text, state: i < current ? 'done' : i === current ? 'current' : 'waiting' }))
}

/** The sentence under the checklist for the current stage, in the first person ("Reading your request…"). */
export function stageSentence(plan: WorkPlan, current: number): string | undefined {
  const text = plan.steps[Math.min(Math.max(current, 0), plan.steps.length - 1)]
  return text ? `${text}…` : undefined
}

/** A running time for a job that has been going a while; nothing for the first few seconds, when it would only be noise. */
export function elapsedText(ms: number, after = 4000): string | undefined {
  if (ms < after) return undefined
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
