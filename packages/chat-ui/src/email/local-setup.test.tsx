import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { FixtureLocalSource, LocalSourceError, generateSyntheticMailbox, type LocalMailSource } from '@buildaharness/aielia'
import { LocalMailSetup } from './LocalMailSetup'

afterEach(() => { cleanup() })
const handlers = () => ({ onUse: vi.fn(), onSignIn: vi.fn(), onCancel: vi.fn() })
const fixture = (): FixtureLocalSource => new FixtureLocalSource(generateSyntheticMailbox({ seed: 2 }))

describe('LocalMailSetup', () => {
  it('lists the accounts it found by count only, uses the chosen ones, and keeps the sign-in route', async () => {
    const h = handlers()
    render(<LocalMailSetup source={fixture()} {...h} />)
    expect(screen.getByRole('status')).toHaveTextContent('Looking for Apple Mail')
    expect(await screen.findByText(/Account 1/)).toBeTruthy()
    expect(screen.getByText(/messages, \d+ folders/)).toBeTruthy()
    expect(screen.getByText(/Sending is always done by you in Mail/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use these accounts' }))
    expect(h.onUse).toHaveBeenCalledWith(['11111111-2222-3333-4444-555555555555'])
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to an account instead' }))
    expect(h.onSignIn).toHaveBeenCalled()
  })
  it('cannot use zero accounts', async () => {
    render(<LocalMailSetup source={fixture()} {...handlers()} />)
    fireEvent.click(await screen.findByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Use these accounts' })).toBeDisabled()
  })
  it('explains Full Disk Access when it is refused, opens the pane, checks again, and offers sign-in', async () => {
    const src = fixture()
    src.unavailable = 'permission_denied'
    const h = handlers(), open = vi.fn()
    render(<LocalMailSetup source={src} {...h} openFullDiskAccessSettings={open} />)
    expect(await screen.findByText(/needs permission to read Apple Mail/)).toBeTruthy()
    expect(screen.getByText(/Full Disk Access/, { selector: 'li' })).toBeTruthy()
    expect(screen.getByText(/optional: you can sign in to an account instead/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(open).toHaveBeenCalled()
    src.unavailable = undefined
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('button', { name: 'Use these accounts' })).toBeTruthy()
  })
  it.each([
    ['not_found', /No Apple Mail mail was found/],
    ['unsupported_layout', /does not know yet/],
    ['unsupported_platform', /works on a Mac/],
    ['weird', /could not read Apple Mail/],
  ])('%s ends at the sign-in route', async (reason, text) => {
    const src = fixture()
    src.unavailable = reason
    const h = handlers()
    render(<LocalMailSetup source={src} {...h} />)
    expect(await screen.findByText(text)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to an account instead' }))
    expect(h.onSignIn).toHaveBeenCalled()
  })
  it('a source that throws is handled the same way', async () => {
    const bad = { discover: async () => { throw new LocalSourceError('permission_denied') } } as unknown as LocalMailSource
    render(<LocalMailSetup source={bad} {...handlers()} />)
    expect(await screen.findByText(/needs permission to read Apple Mail/)).toBeTruthy()
  })
  it('account names are offered, not fetched on their own, and a refusal is shown without breaking the screen', async () => {
    const names = vi.fn().mockResolvedValue([{ id: '11111111-2222-3333-4444-555555555555', name: 'Work' }])
    render(<LocalMailSetup source={fixture()} {...handlers()} listAccountNames={names} />)
    await screen.findByText(/Account 1/)
    expect(names).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show account names' }))
    expect(await screen.findByText(/Work/)).toBeTruthy()
    cleanup()
    const denied = vi.fn().mockRejectedValue(new Error('Allow Aielia to control Mail'))
    render(<LocalMailSetup source={fixture()} {...handlers()} listAccountNames={denied} />)
    await screen.findByText(/Account 1/)
    fireEvent.click(screen.getByRole('button', { name: 'Show account names' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Allow Aielia to control Mail'))
    expect(screen.getByText(/Account 1/)).toBeTruthy()
  })
})
