import type { AskQuestion, AssistantTurnResult } from '@buildaharness/personal-assistant'

type AskableResult = Pick<AssistantTurnResult, 'status' | 'questions' | 'pendingClarificationId'>

/**
 * Q5 (plans/ask_question_and_plan_mode_plan.html) — the one place that decides whether a
 * `needs_clarification` result gets the real interactive AskQuestionCard or falls back to the
 * pre-existing plain-text EscalationBanner. Kept as a small pure function (mirrors
 * ChatMessageBubble.tsx's answerClaimLabel/verificationHealthLabel convention) so App.tsx's
 * runTurn branch and its test coverage don't have to mount the whole app to exercise the
 * decision: `questions` must be a non-empty array AND `pendingClarificationId` must be set,
 * since AskQuestionCard has nothing to render and no way to resume without both. A type
 * predicate (rather than a bare boolean) so the call site's `result.questions`/
 * `result.pendingClarificationId` narrow to non-undefined without a manual cast.
 */
export function shouldRenderAskQuestionCard(
  result: AskableResult,
): result is AskableResult & { pendingClarificationId: string; questions: AskQuestion[] } {
  return (
    result.status === 'needs_clarification' &&
    !!result.pendingClarificationId &&
    !!result.questions &&
    result.questions.length > 0
  )
}
