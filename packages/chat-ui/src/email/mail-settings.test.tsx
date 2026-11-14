import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { BulkPreview, MailActionRecord, MailChip } from '@buildaharness/aielia'
import { MailSettings } from './MailSettings'
import { MailChatColumn } from './MailChatColumn'

afterEach(() => { cleanup() })

const privacy = { aieliaMayRead: true, excludedFolders: ['Legal'], excludedSenders: [] }
const accounts = [{ id: 'a1', address: 'me@example.org', provider: 'gmail', privacy }]
const perms = { organiseWithoutAsking: false }

describe('MailSettings', () => {
  it('switching an account off is reported and saved', () => {
    const onPrivacy = vi.fn()
    render(<MailSettings accounts={accounts} permissions={perms} onPrivacy={onPrivacy} onPermissions={vi.fn()} onDisconnect={vi.fn()} onDeleteAll={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/may read this account/))
    expect(onPrivacy).toHaveBeenCalledWith('a1', { ...privacy, aieliaMayRead: false })
  })

  it('exclusions and the spend cap are saved', () => {
    const onPrivacy = vi.fn(); const onPerms = vi.fn()
    render(<MailSettings accounts={accounts} permissions={perms} onPrivacy={onPrivacy} onPermissions={onPerms} onDisconnect={vi.fn()} onDeleteAll={vi.fn()} />)
    const f = screen.getByLabelText('Excluded folders for me@example.org')
    fireEvent.change(f, { target: { value: 'Legal, Medical' } }); fireEvent.blur(f)
    expect(onPrivacy).toHaveBeenCalledWith('a1', { ...privacy, excludedFolders: ['Legal', 'Medical'] })
    const cap = screen.getByLabelText('Spending cap')
    fireEvent.change(cap, { target: { value: '5' } }); fireEvent.blur(cap)
    expect(onPerms).toHaveBeenCalledWith({ organiseWithoutAsking: false, spendCapUsd: 5 })
  })

  it('disconnect asks first, then shows how to revoke the grant', async () => {
    const onDisconnect = vi.fn().mockResolvedValue({ accountId: 'a1', removed: [], revoke: { where: 'your Google Account', url: 'https://myaccount.google.com/permissions', steps: 'Choose Remove access.' } })
    render(<MailSettings accounts={accounts} permissions={perms} onPrivacy={vi.fn()} onPermissions={vi.fn()} onDisconnect={onDisconnect} onDeleteAll={vi.fn()} />)
    fireEvent.click(screen.getByText('Disconnect me@example.org'))
    expect(onDisconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Disconnect'))
    await screen.findByText(/until you remove it there/)
    expect(onDisconnect).toHaveBeenCalledWith('a1')
    expect(screen.getByText('Choose Remove access.')).toBeTruthy()
  })

  it('delete all data needs a confirmation and then runs once', async () => {
    const onDeleteAll = vi.fn().mockResolvedValue(undefined)
    render(<MailSettings accounts={accounts} permissions={perms} onPrivacy={vi.fn()} onPermissions={vi.fn()} onDisconnect={vi.fn()} onDeleteAll={onDeleteAll} />)
    fireEvent.click(screen.getByText('Delete all data'))
    expect(onDeleteAll).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Keep'))
    fireEvent.click(screen.getByText('Delete all data'))
    fireEvent.click(screen.getByText('Delete everything'))
    await waitFor(() => expect(onDeleteAll).toHaveBeenCalledTimes(1))
    await screen.findByText(/was deleted/)
  })
})

describe('MailChatColumn', () => {
  const chips: MailChip[] = [{ kind: 'message', messageId: 'm1', label: 'Invoice' }]
  const base = { lines: [], chips, onRemoveChip: vi.fn(), input: 'hi', onInput: vi.fn(), onSend: vi.fn(), busy: false, spend: { usd: 0.0123, byType: [] } }

  it('shows chips that can be removed, and says so when none is left', () => {
    const onRemove = vi.fn()
    const { rerender } = render(<MailChatColumn {...base} onRemoveChip={onRemove} />)
    fireEvent.click(screen.getByLabelText('Remove: This message: Invoice'))
    expect(onRemove).toHaveBeenCalledWith('message:m1')
    rerender(<MailChatColumn {...base} chips={[]} />)
    expect(screen.getByText(/no "this one" yet/)).toBeTruthy()
  })

  it('shows progress with Stop only while a job runs', () => {
    const onStop = vi.fn()
    const { rerender } = render(<MailChatColumn {...base} />)
    expect(screen.queryByText('Stop')).toBeNull()
    rerender(<MailChatColumn {...base} progress={{ label: 'Sorting new threads', stage: 'reading', count: [3, 10] }} onStop={onStop} />)
    expect(screen.getByText(/3 of 10/)).toBeTruthy()
    fireEvent.click(screen.getByText('Stop'))
    expect(onStop).toHaveBeenCalled()
  })

  it('previews a change before it is applied, and offers undo after', () => {
    const preview = { change: { type: 'archive' }, rows: [{ messageId: 'm1', subject: 'Invoice' }], unchanged: [], missing: [], overCeiling: false, needsConfirmation: false } as unknown as BulkPreview
    const onApply = vi.fn(); const onUndo = vi.fn()
    const action = { id: 'act-1', accountId: 'a1', at: 'x', change: { type: 'archive' }, entries: [{}] } as unknown as MailActionRecord
    render(<MailChatColumn {...base} preview={preview} onApplyPreview={onApply} lastAction={action} onUndo={onUndo} />)
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Apply')); expect(onApply).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Undo')); expect(onUndo).toHaveBeenCalled()
  })

  it('offers no file or shell controls', () => {
    const { container } = render(<MailChatColumn {...base} />)
    expect(container.querySelector('input[type=file]')).toBeNull()
    expect(container.textContent).not.toMatch(/shell|terminal/i)
  })
})
