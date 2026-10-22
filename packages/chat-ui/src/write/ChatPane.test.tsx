import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatPane, RECORD_HINT, type WorkProgress } from './ChatPane'

const base = { lines: [], model: 'm', suggestions: [], onModel: () => undefined, input: '', onInput: () => undefined, mode: 'edit' as const, onMode: () => undefined, editLabel: 'Edit', busy: true, canAct: true, shown: true, onSend: () => undefined, onAdjust: () => undefined, onAction: () => undefined, repos: [], onRepoVerify: () => undefined, onRemoveRepo: () => undefined, onDropFiles: () => undefined, onClose: () => undefined }

describe('ChatPane work ticker', () => {
  const progress: WorkProgress = { kind: 'edit', label: 'Editing', stage: 1, detail: 'one more moment', startedAt: Date.now() }
  it('says the stage, the finer step and a checklist with the earlier steps done', () => {
    render(<ChatPane {...base} progress={progress} />)
    expect(screen.getByText('Noting what you said…')).toBeInTheDocument()
    expect(screen.getByText('one more moment')).toBeInTheDocument()
    const steps = screen.getByLabelText('Steps').querySelectorAll('li')
    expect([...steps].map((l) => l.className)).toEqual(['is-done', 'is-current', 'is-waiting'])
  })
  it('is gone when the work is over', () => {
    render(<ChatPane {...base} progress={null} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByLabelText('Steps')).toBeNull()
  })
  it('shows the count, the words of an answer as they come, and Stop; and a finished job shows Done', async () => {
    let stopped = 0
    const { rerender } = render(<ChatPane {...base} onStop={() => { stopped++ }} progress={{ ...progress, kind: 'verify', stage: 2, count: [4, 11], streamed: 'The answer so f' }} />)
    expect(screen.getByText('4 of 11 done')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4')
    expect(screen.getByText('The answer so f')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Stop' }).click()
    expect(stopped).toBe(1)
    rerender(<ChatPane {...base} onStop={() => undefined} progress={{ ...progress, kind: 'verify', finishing: true }} />)
    expect(screen.getByText('Done.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect([...screen.getByLabelText('Steps').querySelectorAll('li')].every((l) => l.className === 'is-done')).toBe(true)
  })
})

describe('ChatPane: records of interface actions', () => {
  it('draws a record apart from a chat message and says on hover what it is', () => {
    render(<ChatPane {...base} lines={[{ id: 1, from: 'you', text: 'Check the claims', record: true }, { id: 2, from: 'aielia', text: 'Check: done.', record: true }, { id: 3, from: 'you', text: 'Is it clear?' }, { id: 4, from: 'aielia', text: 'Yes.', model: 'm' }]} progress={null} />)
    for (const t of ['Check the claims', 'Check: done.']) {
      const li = screen.getByText(t).closest('li')!
      expect(li).toHaveClass('write__line--record')
      expect(li).toHaveAttribute('title', RECORD_HINT)
    }
    for (const t of ['Is it clear?', 'Yes.']) {
      const li = screen.getByText(t).closest('li')!
      expect(li).not.toHaveClass('write__line--record')
      expect(li).not.toHaveAttribute('title')
    }
  })
})
