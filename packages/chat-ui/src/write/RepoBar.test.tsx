import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RepoBar } from './RepoBar'

describe('repository bar', () => {
  it('adds a GitHub address on Enter and clears the box, lists attached repositories, and removes one', async () => {
    const onAdd = vi.fn()
    const onRemove = vi.fn()
    render(<RepoBar repos={['o/r']} busy={false} onAddGithub={onAdd} onRemove={onRemove} />)
    expect(screen.getByText('o/r')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('GitHub repository address'), 'github.com/o/other{Enter}')
    expect(onAdd).toHaveBeenCalledWith('github.com/o/other')
    expect(screen.getByLabelText('GitHub repository address')).toHaveValue('')
    await userEvent.click(screen.getByRole('button', { name: 'Stop using o/r' }))
    expect(onRemove).toHaveBeenCalledWith('o/r')
  })
  it('shows the folder button only where a folder can be chosen, and does nothing while busy', async () => {
    const onAdd = vi.fn()
    const onPick = vi.fn()
    const { rerender } = render(<RepoBar repos={[]} busy={false} onAddGithub={onAdd} onRemove={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /repository folder/ })).toBeNull()
    rerender(<RepoBar repos={[]} busy onAddGithub={onAdd} onPickFolder={onPick} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: /repository folder/ })).toBeDisabled()
    expect(screen.getByLabelText('GitHub repository address')).toBeDisabled()
  })
})

import { AdjustBar } from './AdjustBar'
describe('the repository action in the chat menu', () => {
  it('is offered only when a repository is attached, and runs as an action', async () => {
    const onAction = vi.fn()
    const { rerender } = render(<AdjustBar disabled={false} checkLabel="Check" verifyLabel="Verify" onSend={vi.fn()} onAction={onAction} />)
    expect(screen.queryByRole('option', { name: 'Verify the claims against the repository' })).toBeNull()
    rerender(<AdjustBar disabled={false} checkLabel="Check" verifyLabel="Verify" repoLabel="Verify the claims against the repository" onSend={vi.fn()} onAction={onAction} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'action:verify_repo')
    expect(onAction).toHaveBeenCalledWith('verify_repo')
  })
})
