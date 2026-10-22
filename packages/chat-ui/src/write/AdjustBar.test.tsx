import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdjustBar } from './AdjustBar'

const base = { disabled: false, checkLabel: 'Check', verifyLabel: 'Verify', onSend: vi.fn(), onAction: vi.fn() }

describe('the repository option of the chat menu', () => {
  it('shows nothing about repositories until the option is chosen, then asks for an address and runs on Enter', async () => {
    const onRepoVerify = vi.fn()
    render(<AdjustBar {...base} onRepoVerify={onRepoVerify} />)
    expect(screen.queryByLabelText('Repository address')).toBeNull()
    await userEvent.selectOptions(screen.getByRole('combobox'), 'action:verify_repo')
    await userEvent.type(screen.getByLabelText('Repository address'), 'github.com/o/r{Enter}')
    expect(onRepoVerify).toHaveBeenCalledWith('github.com/o/r')
    expect(screen.queryByLabelText('Repository address')).toBeNull()
  })
  it('lists the repositories already attached, lets one be dropped, and runs with an empty address to use them', async () => {
    const onRepoVerify = vi.fn()
    const onRemove = vi.fn()
    render(<AdjustBar {...base} repos={['o/r']} onRepoVerify={onRepoVerify} onRemoveRepo={onRemove} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'action:verify_repo')
    await userEvent.click(screen.getByRole('button', { name: 'Stop using o/r' }))
    expect(onRemove).toHaveBeenCalledWith('o/r')
    await userEvent.type(screen.getByLabelText('Repository address'), '{Enter}')
    expect(onRepoVerify).toHaveBeenCalledWith('')
  })
  it('offers the folder button only where a folder can be chosen, and the option only when the page can verify against a repository', async () => {
    const onPick = vi.fn()
    const { rerender } = render(<AdjustBar {...base} />)
    expect(screen.queryByRole('option', { name: 'Verify the claims against a repository' })).toBeNull()
    rerender(<AdjustBar {...base} onRepoVerify={vi.fn()} onPickRepoFolder={onPick} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'action:verify_repo')
    await userEvent.click(screen.getByRole('button', { name: 'Use a repository folder on this computer' }))
    expect(onPick).toHaveBeenCalled()
  })
})

describe('the fill-in action', () => {
  it('runs as an action when chosen', async () => {
    const onAction = vi.fn()
    render(<AdjustBar {...base} onAction={onAction} />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'action:prepare')
    expect(onAction).toHaveBeenCalledWith('prepare')
  })
})

describe('the adjust categories', () => {
  it('lists a few categories rather than every aspect, and sends the typed words after Enter', async () => {
    const onSend = vi.fn()
    render(<AdjustBar {...base} onSend={onSend} />)
    expect(screen.getAllByRole('option').length).toBeLessThan(20)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'tone')
    await userEvent.type(screen.getByLabelText('How'), 'less like a press release{Enter}')
    expect(onSend).toHaveBeenCalledWith(expect.stringContaining('Adjust the article: less like a press release'))
  })
})
