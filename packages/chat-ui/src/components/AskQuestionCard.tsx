import { useState } from 'react'
import type { AskAnswer, AskQuestion, AskQuestionOption, AskResponse } from '@buildaharness/personal-assistant'

interface Props {
  questions: AskQuestion[]
  resolution?: 'answered'
  /** Set alongside `resolution: 'answered'` — see ChatEntry's 'clarification' doc comment. */
  answer?: AskResponse
  onSubmit: (response: AskResponse) => void
}

/**
 * One question's in-progress answer. Kept separate from AskAnswer itself so a user can flip
 * between picking an option and typing free text without losing whichever they touched last —
 * `draftToAnswer` below is what actually collapses this back down to the wire shape.
 */
interface QuestionDraft {
  selectedLabels: string[]
  showEdit: boolean
  editText: string
  freeText: string
}

function emptyDraft(): QuestionDraft {
  return { selectedLabels: [], showEdit: false, editText: '', freeText: '' }
}

/** Recommended option(s) first, per the plan's "recommended option rendered first" — stable otherwise. */
function orderedOptions(question: AskQuestion): AskQuestionOption[] {
  const options = question.options ?? []
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => Number(b.option.recommended ?? false) - Number(a.option.recommended ?? false) || a.index - b.index)
    .map(({ option }) => option)
}

/** Collapses one question's draft into the wire AskAnswer shape, or null while still unanswered (INV-28). */
function draftToAnswer(questionId: string, draft: QuestionDraft): AskAnswer | null {
  if (draft.selectedLabels.length > 0) {
    return draft.showEdit && draft.editText.trim()
      ? { questionId, kind: 'selected_with_edit', selectedLabels: draft.selectedLabels, editText: draft.editText.trim() }
      : { questionId, kind: 'selected', selectedLabels: draft.selectedLabels }
  }
  if (draft.freeText.trim()) {
    return { questionId, kind: 'free_text', freeText: draft.freeText.trim() }
  }
  return null
}

/** Short, human-readable line for the resolved (already-submitted) view — the answer summary counterpart of ApprovalCard's "Approved."/"Denied." line. */
function summarizeAnswer(answer: AskAnswer | undefined): string {
  if (!answer) return '(no answer)'
  switch (answer.kind) {
    case 'selected':
      return answer.selectedLabels.join(', ')
    case 'selected_with_edit':
      return `${answer.selectedLabels.join(', ')} (note: ${answer.editText})`
    case 'free_text':
      return answer.freeText
  }
}

export function AskQuestionCard({ questions, resolution, answer, onSubmit }: Props): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, emptyDraft()])),
  )
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null)

  if (resolution === 'answered') {
    const byId = new Map((answer?.answers ?? []).map((a) => [a.questionId, a]))
    return (
      <div className="ask-question-card ask-question-card--resolved">
        <div className="ask-question-card__header">Answered</div>
        <ul className="ask-question-card__resolved-list">
          {questions.map((q) => (
            <li key={q.id}>
              <span className="ask-question-card__resolved-question">{q.question}</span>
              {' — '}
              <span className="ask-question-card__resolved-answer">{summarizeAnswer(byId.get(q.id))}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const question = questions[index]
  const draft = drafts[question.id]
  const options = orderedOptions(question)
  const allowFreeText = question.allowFreeText !== false
  const previewOption = options.find((o) => o.label === hoveredLabel && o.preview)

  const answers = questions.map((q) => draftToAnswer(q.id, drafts[q.id]))
  const allAnswered = answers.every((a) => a !== null)

  function updateDraft(questionId: string, patch: Partial<QuestionDraft>): void {
    setDrafts((prev) => ({ ...prev, [questionId]: { ...prev[questionId], ...patch } }))
  }

  function selectOption(label: string): void {
    if (question.allowMultiple) {
      const already = draft.selectedLabels.includes(label)
      updateDraft(question.id, {
        selectedLabels: already ? draft.selectedLabels.filter((l) => l !== label) : [...draft.selectedLabels, label],
        freeText: '',
      })
    } else {
      updateDraft(question.id, { selectedLabels: [label], freeText: '' })
    }
  }

  function handleFreeTextChange(value: string): void {
    updateDraft(question.id, { freeText: value, selectedLabels: [], showEdit: false, editText: '' })
  }

  function handleSubmit(): void {
    if (!allAnswered) return
    onSubmit({ answers: answers as AskAnswer[] })
  }

  return (
    <div className="ask-question-card" data-testid="ask-question-card">
      <div className="ask-question-card__body">
        <div className="ask-question-card__question-head">
          {question.header && <span className="ask-question-card__chip">{question.header}</span>}
          {questions.length > 1 && (
            <span className="ask-question-card__progress">
              Question {index + 1} of {questions.length}
            </span>
          )}
        </div>
        <div className="ask-question-card__question-text">{question.question}</div>

        {options.length > 0 && (
          <div className="ask-question-card__options">
            {options.map((option) => (
              <label
                key={option.label}
                className="ask-question-card__option"
                onMouseEnter={() => setHoveredLabel(option.label)}
                onMouseLeave={() => setHoveredLabel((prev) => (prev === option.label ? null : prev))}
                onFocus={() => setHoveredLabel(option.label)}
                onBlur={() => setHoveredLabel((prev) => (prev === option.label ? null : prev))}
              >
                <input
                  type={question.allowMultiple ? 'checkbox' : 'radio'}
                  name={`ask-question-${question.id}`}
                  checked={draft.selectedLabels.includes(option.label)}
                  onChange={() => selectOption(option.label)}
                />
                <span className="ask-question-card__option-label">
                  {option.label}
                  {option.recommended && <span className="ask-question-card__recommended"> (Recommended)</span>}
                </span>
                {option.description && <span className="ask-question-card__option-description">{option.description}</span>}
              </label>
            ))}
          </div>
        )}

        {previewOption?.preview && <div className="ask-question-card__preview">{previewOption.preview}</div>}

        {draft.selectedLabels.length > 0 && (
          <div className="ask-question-card__edit">
            {!draft.showEdit ? (
              <button type="button" className="ask-question-card__add-note" onClick={() => updateDraft(question.id, { showEdit: true })}>
                Add a note
              </button>
            ) : (
              <input
                type="text"
                className="ask-question-card__edit-input"
                placeholder="Add a note about your selection…"
                value={draft.editText}
                onChange={(e) => updateDraft(question.id, { editText: e.target.value })}
              />
            )}
          </div>
        )}

        {allowFreeText && (
          <input
            type="text"
            className="ask-question-card__free-text"
            placeholder="Other — type your own answer…"
            value={draft.freeText}
            onChange={(e) => handleFreeTextChange(e.target.value)}
          />
        )}
      </div>

      <div className="ask-question-card__nav">
        {questions.length > 1 && (
          <>
            <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
              Back
            </button>
            <button type="button" onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))} disabled={index === questions.length - 1}>
              Next
            </button>
          </>
        )}
        <button type="button" className="ask-question-card__submit" onClick={handleSubmit} disabled={!allAnswered}>
          Submit
        </button>
      </div>
    </div>
  )
}
