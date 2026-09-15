import type { ControlState } from '../state/control-state.js'
import type { StrategyState } from '../state/strategy-state.js'
import { CallerState } from '../state/caller-state.js'
import {
  applyConstraintChangePropagation,
  type ConstraintPropagationContext,
} from './check-caller-updates.js'

export type EscalationReason =
  | 'blocked_state'
  | 'cannot_make_progress'
  | 'budget_exhausted'
  | 'review_failure'
  | 'action_requires_compressed_state'
  | 'supervisor_question'

// Q0 — shared question/answer types (batched ask-question mechanism), twin of
// adapter/harness/escalation.py. These caps mirror the live AskUserQuestion tool
// definition exactly: a hard ceiling on one SurfaceBlocker's questions, and a
// floor/ceiling on any one question's options. A caller with more than
// MAX_QUESTIONS_PER_BATCH genuinely-needed questions is a sequential-batching
// problem (see batchQuestions()/refineDeferredBatch(), INV-37), never a reason
// to raise these.
export const MAX_QUESTIONS_PER_BATCH = 4
export const MIN_OPTIONS_PER_QUESTION = 2
export const MAX_OPTIONS_PER_QUESTION = 4

export interface AskQuestionOption {
  label: string
  description?: string
  // Mutually exclusive with allowMultiple on the owning question, per the live
  // AskUserQuestion tool schema's own constraint.
  preview?: string
  recommended?: boolean
}

export interface AskQuestion {
  id: string
  header?: string // <= 12 chars, per AskUserQuestion's own convention
  question: string
  options?: AskQuestionOption[]
  allowMultiple?: boolean // default false; must be false when any option carries `preview`
  allowFreeText?: boolean // default true — the automatic "Other" affordance (Section 3-F)
}

export type AskAnswer =
  | { questionId: string; kind: 'selected'; selectedLabels: string[] }
  | { questionId: string; kind: 'selected_with_edit'; selectedLabels: string[]; editText: string }
  | { questionId: string; kind: 'free_text'; freeText: string }

export interface AskResponse {
  answers: AskAnswer[]
}

export function validateAskQuestion(q: AskQuestion): void {
  if (q.options !== undefined) {
    if (q.options.length < MIN_OPTIONS_PER_QUESTION || q.options.length > MAX_OPTIONS_PER_QUESTION) {
      throw new Error(
        `AskQuestion "${q.id}": options must have between ${MIN_OPTIONS_PER_QUESTION} and ` +
          `${MAX_OPTIONS_PER_QUESTION} entries, got ${q.options.length}`,
      )
    }
    if (q.allowMultiple && q.options.some((o) => o.preview !== undefined)) {
      throw new Error(`AskQuestion "${q.id}": options with "preview" cannot be combined with allowMultiple`)
    }
  }
}

/**
 * Validate a batch of questions against INV-34's per-batch cap. Each AskQuestion
 * should already be valid on its own (validateAskQuestion); this only enforces
 * the batch-level MAX_QUESTIONS_PER_BATCH ceiling. Raises loudly rather than
 * silently truncating.
 */
export function makeQuestionsBatch(questions: AskQuestion[]): AskQuestion[] {
  if (questions.length > MAX_QUESTIONS_PER_BATCH) {
    throw new Error(
      `questions batch exceeds the ${MAX_QUESTIONS_PER_BATCH}-question cap (got ${questions.length}); ` +
        'use batchQuestions() to split into sequential batches',
    )
  }
  questions.forEach(validateAskQuestion)
  return questions
}

/**
 * Validate one AskAnswer's internal shape — `kind` determines which of
 * selectedLabels/editText/freeText is populated, so a payload can never mix
 * shapes (e.g. a `free_text` answer carrying `selectedLabels`).
 */
export function validateAskAnswer(answer: AskAnswer): void {
  switch (answer.kind) {
    case 'selected':
      if (answer.selectedLabels.length === 0) {
        throw new Error(
          `AskAnswer for "${answer.questionId}": kind "selected" requires at least one selected label`,
        )
      }
      break
    case 'selected_with_edit':
      if (answer.selectedLabels.length === 0) {
        throw new Error(
          `AskAnswer for "${answer.questionId}": kind "selected_with_edit" requires at least one selected label`,
        )
      }
      if (!answer.editText) {
        throw new Error(`AskAnswer for "${answer.questionId}": kind "selected_with_edit" requires non-empty editText`)
      }
      break
    case 'free_text':
      if (!answer.freeText) {
        throw new Error(`AskAnswer for "${answer.questionId}": kind "free_text" requires non-empty freeText`)
      }
      break
    default:
      // A payload deserialized from JSON (e.g. a resumed escalation) isn't guaranteed to match
      // the AskAnswer union at runtime — mirrors the Python twin's AskAnswer.__post_init__,
      // which raises ValueError on an unrecognized kind rather than passing it through silently.
      throw new Error(`AskAnswer for "${(answer as { questionId: string }).questionId}": unknown kind "${(answer as { kind: string }).kind}"`)
  }
}

/**
 * Cross-check a resolve payload against the batch of questions it answers.
 * Every question must have exactly one matching answer; an allowMultiple: false
 * question must not receive more than one selected label. Throws on the first
 * violation found — used by callers resolving a batch (Q2/Q3), not by
 * AskAnswer/AskQuestion construction themselves.
 */
export function validateAskResponse(questions: AskQuestion[], response: AskResponse): void {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const answeredIds = new Set<string>()
  for (const answer of response.answers) {
    validateAskAnswer(answer)
    const question = byId.get(answer.questionId)
    if (!question) {
      throw new Error(`AskResponse: answer references unknown question id "${answer.questionId}"`)
    }
    if (
      !question.allowMultiple &&
      (answer.kind === 'selected' || answer.kind === 'selected_with_edit') &&
      answer.selectedLabels.length > 1
    ) {
      throw new Error(`AskResponse: question "${question.id}" does not allow multiple selections`)
    }
    answeredIds.add(answer.questionId)
  }
  const missing = questions.filter((q) => !answeredIds.has(q.id))
  if (missing.length > 0) {
    throw new Error(`AskResponse: missing answers for question id(s) ${missing.map((q) => q.id).join(', ')}`)
  }
}

/**
 * Split ranked candidates into a first batch (top `cap`) and an ordered deferred
 * remainder. `candidates` must already be ranked by the caller (most
 * plan-changing first) — this only enforces INV-34's per-batch cap, it does not
 * rank (INV-37).
 */
export function batchQuestions(
  candidates: AskQuestion[],
  cap: number = MAX_QUESTIONS_PER_BATCH,
): { batch: AskQuestion[]; deferred: AskQuestion[] } {
  if (cap < 1) {
    throw new Error('cap must be >= 1')
  }
  return { batch: candidates.slice(0, cap), deferred: candidates.slice(cap) }
}

/**
 * Re-evaluate a deferred list after folding in an earlier batch's answers.
 * `isMoot` is caller-supplied domain logic (e.g. "does batch one's answer
 * already resolve this question") — this only filters and re-applies INV-34's
 * cap (INV-37); it never decides mootness itself.
 */
export function refineDeferredBatch(
  deferred: AskQuestion[],
  isMoot: (q: AskQuestion) => boolean,
  cap: number = MAX_QUESTIONS_PER_BATCH,
): AskQuestion[] {
  return deferred.filter((q) => !isMoot(q)).slice(0, cap)
}

export interface SurfaceBlocker {
  reason: EscalationReason
  missing_info: string[]
  current_task_summary: string
  escalated_at: string
  // Trajectory Supervisor ASK_USER (S3) — structured question + optional choices.
  // Omitted entirely (not null) on a plain escalation, matching the Python twin.
  question?: string
  options?: string[]
  // Q0 — batched ask-question mechanism (INV-26): kept alongside the single
  // question/options fields above for the rollout window. When unset,
  // serialization and rendering are byte-identical to a pre-Q0 SurfaceBlocker.
  questions?: AskQuestion[]
}

export class EscalationHalt extends Error {
  blocker: SurfaceBlocker

  constructor(blocker: SurfaceBlocker) {
    super(`Escalation halt: ${blocker.reason}`)
    this.name = 'EscalationHalt'
    this.blocker = blocker
  }
}

export function makeSurfaceBlocker(
  reason: EscalationReason,
  missing_info: string[],
  current_task_summary: string,
  questions?: AskQuestion[],
): SurfaceBlocker {
  const blocker: SurfaceBlocker = {
    reason,
    missing_info,
    current_task_summary,
    escalated_at: new Date().toISOString(),
  }
  if (questions !== undefined) {
    blocker.questions = makeQuestionsBatch(questions)
  }
  return blocker
}

export function awaitClarification(blocker: SurfaceBlocker): never {
  throw new EscalationHalt(blocker)
}

export function escalateBudgetExhausted(
  stepCount: number,
  maxSteps: number,
): { escalated: true; reason: string; missing_info: string[] } {
  return {
    escalated: true,
    reason: 'budget_exhausted',
    missing_info: [`Step count ${stepCount} reached max_steps limit of ${maxSteps}`],
  }
}

export function escalate(
  _controlState: ControlState,
  _strategyState: StrategyState,
  reason: EscalationReason,
  missingInfo: string[],
  currentTaskSummary: string,
): never {
  const blocker = makeSurfaceBlocker(reason, missingInfo, currentTaskSummary)
  throw new EscalationHalt(blocker)
}

export function handleEscalationResponse(
  callerState: CallerState,
  humanResponse: Record<string, unknown>,
  ctx: ConstraintPropagationContext,
): void {
  callerState.updateConstraints(humanResponse)
  if (callerState.constraints_changed) {
    applyConstraintChangePropagation(callerState, ctx)
  }
}
