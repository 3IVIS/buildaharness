import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApprovalCard } from './ApprovalCard'

function renderCard(reason: string, pendingActionKind: 'write' | 'shell' | 'email' = 'write') {
  return render(<ApprovalCard pendingMessage="do it" reason={reason} pendingActionKind={pendingActionKind} onApprove={vi.fn()} onDeny={vi.fn()} />)
}

describe('ApprovalCard', () => {
  it('shows a new file\'s lines as a separate monospace block, keeping line breaks', () => {
    const { container } = renderCard('Proposes writing to "tea.md":\nline one\nline two')
    expect(screen.getByText('Proposes writing to "tea.md":')).toBeInTheDocument()
    const detail = screen.getByLabelText('Exact change')
    expect(detail.textContent).toBe('line one\nline two\n')
    expect(container.querySelector('.approval-card__reason')?.textContent).not.toContain('line one')
  })

  it('marks added and removed rows of a numbered diff', () => {
    renderCard('Proposes writing to "a.md":\n  1  keep\n  2 -old\n  2 +new')
    const detail = screen.getByLabelText('Exact change')
    expect(detail.querySelectorAll('.approval-card__line--add')).toHaveLength(1)
    expect(detail.querySelectorAll('.approval-card__line--del')).toHaveLength(1)
  })

  it('shows the command and its working directory for a shell action', () => {
    renderCard('Proposes running: uname -a\n  (cwd: /ws)', 'shell')
    expect(screen.getByText('Proposes running: uname -a')).toBeInTheDocument()
    expect(screen.getByLabelText('Exact change').textContent).toContain('(cwd: /ws)')
  })

  it('renders a one-line reason without an empty detail block', () => {
    renderCard('This action needs approval.')
    expect(screen.queryByLabelText('Exact change')).toBeNull()
  })
})
