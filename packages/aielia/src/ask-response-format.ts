import type { AskQuestion, AskResponse } from '@buildaharness/harness'

/** Renders one AskAnswer as a short human-readable line, for the transcript and for the harness's own clarification_history. */
function formatAnswer(question: AskQuestion | undefined, answer: AskResponse['answers'][number]): string {
  const label = question?.question ?? answer.questionId
  switch (answer.kind) {
    case 'selected':
      return `${label}: ${answer.selectedLabels.join(', ')}`
    case 'selected_with_edit':
      return `${label}: ${answer.selectedLabels.join(', ')} (note: ${answer.editText})`
    case 'free_text':
      return `${label}: ${answer.freeText}`
  }
}

/**
 * Renders a full AskResponse as one transcript-ready message — shared by
 * AskClarificationService (Q2, resuming a paused harness run) and PlanDraftingService's nested-ask
 * resolution (P8, continuing a plan draft), both of which fold the user's answer into a plain-text
 * follow-up message for their own "next call" rather than duplicating this formatting logic.
 */
/**
 * The user-visible text of a batch of structured questions: each question, then its numbered options. Used for the
 * debug log (a `needs_clarification` turn has `reply: null`, so its log line used to read "(no reply)") and by the
 * eval arm, so the transcript a judge reads carries what the user was actually asked.
 */
export function formatAskQuestions(questions: AskQuestion[]): string {
  return questions
    .map((q) => [`QUESTION: ${q.question}`, ...(q.options ?? []).map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)].join('\n'))
    .join('\n')
}

export function formatAskResponse(questions: AskQuestion[], response: AskResponse): string {
  const byId = new Map(questions.map((q) => [q.id, q]))
  return response.answers.map((a) => formatAnswer(byId.get(a.questionId), a)).join('\n')
}
