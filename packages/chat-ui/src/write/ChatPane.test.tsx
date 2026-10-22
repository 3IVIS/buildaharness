import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatPane, type WorkProgress } from './ChatPane'

const base = { lines: [], model: 'm', suggestions: [], onModel: () => undefined, input: '', onInput: () => undefined, mode: 'edit' as const, onMode: () => undefined, editLabel: 'Edit', busy: true, canAct: true, shown: true, onSend: () => undefined, onAdjust: () => undefined, onAction: () => undefined, repos: [], onRepoVerify: () => undefined, onRemoveRepo: () => undefined, onDropFiles: () => undefined, onClose: () => undefined }

describe('ChatPane work ticker', () => {
  const progress: WorkProgress = { kind: 'edit', label: 'Editing', stage: 1, detail: 'one more moment', startedAt: Date.now() }
  it('says the stage, the finer step and a checklist with the earlier steps done', () => {
    render(<ChatPane {...base} progress={progress} />)
    expect(screen.getByText('Reading your request…')).toBeInTheDocument()
    expect(screen.getByText('one more moment')).toBeInTheDocument()
    const steps = screen.getByLabelText('Steps').querySelectorAll('li')
    expect([...steps].map((l) => l.className)).toEqual(['is-done', 'is-current', 'is-waiting'])
  })
  it('is gone when the work is over', () => {
    render(<ChatPane {...base} progress={null} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByLabelText('Steps')).toBeNull()
  })
})
