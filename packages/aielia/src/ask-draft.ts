import type { AskAnswer, AskQuestion, AskQuestionOption } from '@buildaharness/harness'

/**
 * One question's in-progress answer, shared by the CLI's text prompt and AskQuestionCard.tsx. Kept
 * separate from AskAnswer itself so a user can flip between picking an option and typing free text
 * without losing whichever they touched last; draftToAnswer collapses it to the wire shape.
 */
export interface QuestionDraft {
  selectedLabels: string[]
  editText: string
  freeText: string
  /**
   * Only the card sets this: it hides the note field without clearing the text, so `false` means "ignore
   * editText". Left unset (the CLI, which only fills editText through its explicit `e<n>` command), a
   * non-empty editText counts.
   */
  showEdit?: boolean
}

export function emptyDraft(): QuestionDraft {
  return { selectedLabels: [], editText: '', freeText: '' }
}

/** Recommended option(s) first, stable otherwise, so the same question lists its options in the same order on every surface. */
export function orderedOptions(question: AskQuestion): AskQuestionOption[] {
  const options = question.options ?? []
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => Number(b.option.recommended ?? false) - Number(a.option.recommended ?? false) || a.index - b.index)
    .map(({ option }) => option)
}

/** Collapses one question's draft into the wire AskAnswer shape, or null while still unanswered (INV-28). */
export function draftToAnswer(questionId: string, draft: QuestionDraft): AskAnswer | null {
  if (draft.selectedLabels.length > 0) {
    return draft.showEdit !== false && draft.editText.trim()
      ? { questionId, kind: 'selected_with_edit', selectedLabels: draft.selectedLabels, editText: draft.editText.trim() }
      : { questionId, kind: 'selected', selectedLabels: draft.selectedLabels }
  }
  if (draft.freeText.trim()) {
    return { questionId, kind: 'free_text', freeText: draft.freeText.trim() }
  }
  return null
}
