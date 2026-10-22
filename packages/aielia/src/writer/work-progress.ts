/**
 * What Write tells the writer while a model call runs in the background: a short checklist for the kind of job, and the sentence for
 * the stage it is at. Pure, so the browser and desktop builds render the same words. The stages are the real boundaries of the work;
 * nothing here cycles on a timer.
 */

export type WorkKind =
  | 'edit' | 'draft' | 'suggest' | 'answer' | 'verify' | 'check'
  /** Any change to the article that saves the text first and reloads it after; the middle step is the action's own label. */
  | 'change'
  | 'resolve' | 'files' | 'publish' | 'prepare' | 'style' | 'import' | 'page'
  | 'other'

export interface WorkPlan {
  /** The stages of this kind of job, in order, each a phrase for a checklist ("Reading your request"). */
  steps: readonly string[]
}

const PLANS: Record<WorkKind, readonly string[]> = {
  edit: ['Saving your text', 'Noting what you said', 'Making the edit'],
  draft: ['Saving your text', 'Noting what you said', 'Writing the first draft'],
  suggest: ['Saving your text', 'Noting what you said', 'Finding changes to suggest'],
  answer: ['Reading your article', 'Writing the answer'],
  verify: ['Saving your text', 'Finding the claims to check', 'Looking things up', 'Writing up what I found'],
  check: ['Finding the factual claims', 'Summing up what I found'],
  change: [],
  resolve: ['Saving your text', 'Working through the issues', 'Updating the article'],
  files: ['Saving your text', 'Reading the files', 'Finding the claims they bear on', 'Updating the article'],
  publish: ['Saving your text', 'Rechecking the sources', 'Freezing the snapshot'],
  prepare: ['Saving your text', 'Drafting the style sheet', 'Looking for links between sections'],
  style: ['Saving your text', 'Reading the style from the text'],
  import: ['Reading the file', 'Setting up the article', 'Drafting the style sheet', 'Looking for links between sections'],
  page: ['Fetching the page', 'Setting up the article', 'Drafting the style sheet', 'Looking for links between sections'],
  other: [],
}

/** The checklist for a kind of job; empty when the job is too short to need one. A 'change' is named by the action's own `label`. */
export function workPlan(kind: WorkKind, label?: string): WorkPlan {
  if (kind === 'change') return { steps: ['Saving your text', label?.trim() || 'Making the change', 'Updating the article'] }
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

/**
 * The stretch of `after` that differs from `before`, found from the text both start and end with; null when nothing was added or changed
 * (a pure deletion leaves nothing to light). Used to light the passage a job has just written.
 */
export function changedRange(before: string, after: string): { start: number; end: number } | null {
  if (before === after) return null
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let tail = 0
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const end = after.length - tail
  return end > start ? { start, end } : null
}

/**
 * The passage to light after a job changed the text: the changed range, unless it is most of the text (a first draft, a full rewrite),
 * where lighting it would only tint the whole article and point at nothing.
 */
export function litRange(before: string, after: string, maxShare = 0.7): { start: number; end: number } | null {
  const r = changedRange(before, after)
  return r && (r.end - r.start) / Math.max(1, after.length) <= maxShare ? r : null
}
