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
export function formatAskResponse(questions: AskQuestion[], response: AskResponse): string {
  const byId = new Map(questions.map((q) => [q.id, q]))
  return response.answers.map((a) => formatAnswer(byId.get(a.questionId), a)).join('\n')
}
