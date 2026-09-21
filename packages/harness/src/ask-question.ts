import type { AskQuestion, EscalationReason, SurfaceBlocker } from './nodes/escalate.js'
import { EscalationHalt, makeQuestionsBatch } from './nodes/escalate.js'

/**
 * Ask-question primitive — Q1 of the internal plan, twin of
 * adapter/harness/ask_question.py.
 *
 * A generic, independently invocable module that builds a batched-questions (Q0)
 * SurfaceBlocker and halts the run via EscalationHalt — the existing escalate()/
 * EscalationHalt plumbing (nodes/escalate.ts). It is **not** owned by, imported by, or
 * gated behind the Trajectory Supervisor module — the supervisor's own ASK_USER handling
 * (S3, in harness-runtime.ts) is refactored to call this shared primitive instead of
 * constructing its own question/options pair inline, becoming one caller among several
 * rather than the only one. Any other deterministic halt site (Q7) can call it directly.
 *
 * Unlike the Python twin, this package never reads environment variables itself (it's
 * framework-agnostic, used identically in Node and the browser) — the "global flag"
 * channel is a boolean the caller already resolved from its own config (e.g.
 * personal-assistant's `askMode` AssistantConfig field, following `oneLoopMode`'s exact
 * pattern) and passes in as `globalEnabled`. The three control points (Section 5a-1 of the
 * HITL comparison report) still compose the same way, and INV-29 still holds: each can
 * only turn structured questions OFF relative to a broader scope's setting, never ON when
 * a broader scope already said off.
 *
 *   1. Global flag   — `globalEnabled` (resolved upstream from askMode/ASSISTANT_ASK_MODE/
 *                       VITE_ASSISTANT_ASK_MODE, mirroring oneLoopMode's chain).
 *   2. Per-session   — `sessionAskMode: false` forces plain free-text fallback for one turn.
 *   3. Per-call-site — `structured: false` passed straight to askQuestion()/buildAskBlocker().
 *
 * When the effective mode resolves to disabled, buildAskBlocker() does not drop the
 * question entirely — it collapses the (by convention, single) first AskQuestion down to
 * the pre-Q0 SurfaceBlocker.question/.options shape, so a caller that used to build that
 * shape directly (the supervisor's S3 ASK_USER path, before this refactor) reproduces its
 * exact prior output byte-for-byte while the effective global flag is off (the default).
 */

export interface AskModeInputs {
  /** Already-resolved global flag (e.g. personal-assistant's `askMode === 'enabled'`). */
  globalEnabled: boolean
  /** Per-session override — `false` forces structured mode off for this turn regardless of `globalEnabled`. Absent/true defers to `globalEnabled`. */
  sessionAskMode?: boolean
  /** Per-call-site opt-out — `false` forces structured mode off for this call regardless of the other two. Defaults to true. */
  structured?: boolean
}

/**
 * Resolve the effective structured-question mode from all three control points (INV-29):
 * the effective mode is the most restrictive (AND) of the three — a narrower scope can
 * only turn structured mode off relative to a broader scope's setting, never on when a
 * broader scope said off.
 */
export function resolveAskMode({ globalEnabled, sessionAskMode, structured = true }: AskModeInputs): boolean {
  if (!structured) return false
  if (sessionAskMode === false) return false
  return globalEnabled
}

export interface BuildAskBlockerOptions extends AskModeInputs {
  reason: EscalationReason
  missingInfo: string[]
  currentTaskSummary: string
}

/**
 * Build a SurfaceBlocker for a batch of questions, without throwing.
 *
 * When the effective structured mode (resolveAskMode) is enabled, the blocker carries
 * Q0's `questions` batch. When disabled, this degrades to the pre-Q0 single
 * question/options shape, collapsed from the first question in `questions` — never
 * silently dropped — or a plain missing_info-only halt when `questions` is empty.
 */
export function buildAskBlocker(questions: AskQuestion[], opts: BuildAskBlockerOptions): SurfaceBlocker {
  const effective = resolveAskMode(opts)
  const base: SurfaceBlocker = {
    reason: opts.reason,
    missing_info: opts.missingInfo,
    current_task_summary: opts.currentTaskSummary,
    escalated_at: new Date().toISOString(),
  }

  if (effective && questions.length > 0) {
    return { ...base, questions: makeQuestionsBatch(questions) }
  }

  const first = questions[0]
  if (!first) return base
  const options = first.options?.map((o) => o.label)
  return {
    ...base,
    question: first.question,
    ...(options && options.length > 0 ? { options } : {}),
  }
}

/**
 * Build a batched-questions SurfaceBlocker and halt by throwing EscalationHalt — mirrors
 * escalate()'s own contract (nodes/escalate.ts). Thin wrapper, caller-agnostic: any
 * deterministic halt site can call this directly, not just the Trajectory Supervisor.
 */
export function askQuestion(questions: AskQuestion[], opts: BuildAskBlockerOptions): never {
  throw new EscalationHalt(buildAskBlocker(questions, opts))
}

/**
 * Q7 — static, templated options for a budget_exhausted halt, twin of
 * adapter/harness/ask_question.py's build_budget_exhausted_question(). A genuinely
 * discrete, enumerable set of resolutions exists here (per Q7's scope), so every
 * budget_exhausted site offers this unconditionally when the effective ask mode is on —
 * no "does a discrete option set even exist" branching, unlike review_failure (see
 * diagnoseReviewFailureOptions() in nodes/review-proposed-change.ts). Pure, no LLM call.
 */
export function buildBudgetExhaustedQuestion(stepsUsed: number, extension = 10): AskQuestion {
  return {
    id: 'budget-exhausted-resolution',
    question: `The step budget is exhausted (at step ${stepsUsed}). How should I proceed?`,
    options: [
      { label: `Continue with ${extension} more steps` },
      { label: 'Stop and summarize progress so far' },
      { label: 'Let me clarify the goal' },
    ],
  }
}
