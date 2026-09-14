import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AskQuestion, AskResponse } from '@buildaharness/personal-assistant'
import { AskQuestionCard } from './AskQuestionCard'

afterEach(() => cleanup())

const SINGLE_SELECT: AskQuestion = {
  id: 'lang',
  header: 'Language',
  question: 'Which language should the new service use?',
  options: [
    { label: 'Python', description: 'Matches the adapter' },
    { label: 'TypeScript', recommended: true, description: 'Matches the rest of personal-assistant' },
  ],
}

const MULTI_SELECT: AskQuestion = {
  id: 'features',
  question: 'Which features should ship in v1?',
  options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
  allowMultiple: true,
}

const NO_FREE_TEXT: AskQuestion = {
  id: 'confirm',
  question: 'Proceed?',
  options: [{ label: 'Yes' }, { label: 'No' }],
  allowFreeText: false,
}

describe('AskQuestionCard', () => {
  it('renders the recommended option first with a "(Recommended)" suffix', () => {
    render(<AskQuestionCard questions={[SINGLE_SELECT]} onSubmit={vi.fn()} />)
    const options = screen.getAllByRole('radio')
    // TypeScript is `recommended: true` but declared second in the source array — orderedOptions
    // must move it to the front. Asserted via the rendered <label>'s textContent rather than
    // toHaveAccessibleName: the accessible-name algorithm trims/collapses inter-node whitespace,
    // which would hide a real missing space in the actual rendered text.
    expect(options[0].closest('label')?.textContent).toMatch(/^TypeScript \(Recommended\)/)
    expect(screen.getByText('Matches the rest of personal-assistant')).toBeInTheDocument()
  })

  it('Submit is disabled until the single question in the batch is answered, then fires onSubmit with a "selected" answer', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<AskQuestionCard questions={[SINGLE_SELECT]} onSubmit={onSubmit} />)

    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()

    await user.click(screen.getByRole('radio', { name: /Python/ }))
    expect(submit).toBeEnabled()

    await user.click(submit)
    expect(onSubmit).toHaveBeenCalledWith({
      answers: [{ questionId: 'lang', kind: 'selected', selectedLabels: ['Python'] }],
    })
  })

  it('supports multi-select via checkboxes, collecting every checked label', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<AskQuestionCard questions={[MULTI_SELECT]} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('checkbox', { name: 'Auth' }))
    await user.click(screen.getByRole('checkbox', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({
      answers: [{ questionId: 'features', kind: 'selected', selectedLabels: ['Auth', 'Search'] }],
    })
  })

  it('"Add a note" on a selection produces a selected_with_edit answer', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<AskQuestionCard questions={[SINGLE_SELECT]} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('radio', { name: /Python/ }))
    await user.click(screen.getByRole('button', { name: 'Add a note' }))
    await user.type(screen.getByPlaceholderText('Add a note about your selection…'), 'only if it ships faster')
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({
      answers: [{ questionId: 'lang', kind: 'selected_with_edit', selectedLabels: ['Python'], editText: 'only if it ships faster' }],
    })
  })

  it('typing in the standing free-text field produces a free_text answer and clears any selection', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<AskQuestionCard questions={[SINGLE_SELECT]} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('radio', { name: /Python/ }))
    await user.type(screen.getByPlaceholderText('Other — type your own answer…'), 'Rust, actually')
    expect(screen.getByRole('radio', { name: /Python/ })).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({
      answers: [{ questionId: 'lang', kind: 'free_text', freeText: 'Rust, actually' }],
    })
  })

  it('allowFreeText: false hides the standing free-text field', () => {
    render(<AskQuestionCard questions={[NO_FREE_TEXT]} onSubmit={vi.fn()} />)
    expect(screen.queryByPlaceholderText('Other — type your own answer…')).not.toBeInTheDocument()
  })

  it('navigates a multi-question batch with Back/Next and only submits once every question is answered (INV-28)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<AskQuestionCard questions={[SINGLE_SELECT, MULTI_SELECT]} onSubmit={onSubmit} />)

    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()

    await user.click(screen.getByRole('radio', { name: /Python/ }))
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled() // question 2 still unanswered

    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Billing' }))
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Python/ })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({
      answers: [
        { questionId: 'lang', kind: 'selected', selectedLabels: ['Python'] },
        { questionId: 'features', kind: 'selected', selectedLabels: ['Billing'] },
      ],
    })
  })

  it('resolution "answered" renders a static summary instead of live controls', () => {
    const answer: AskResponse = { answers: [{ questionId: 'lang', kind: 'selected', selectedLabels: ['Python'] }] }
    render(<AskQuestionCard questions={[SINGLE_SELECT]} resolution="answered" answer={answer} onSubmit={vi.fn()} />)

    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.getByText('Python')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })
})
