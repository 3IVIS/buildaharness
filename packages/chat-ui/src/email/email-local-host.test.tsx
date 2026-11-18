import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { resolveConfig, FixtureLocalSource, generateSyntheticMailbox } from '@buildaharness/aielia'

const config = resolveConfig({ llmBackend: 'anthropic', apiKey: 'k' }).config
vi.mock('./desktop-platform', async (orig) => ({ ...(await orig<typeof import('./desktop-platform')>()), desktopEmailPlatform: async () => ({}) }))
afterEach(() => { cleanup() })

const kit = (over: Partial<FixtureLocalSource> = {}) => {
  const source = Object.assign(new FixtureLocalSource(generateSyntheticMailbox({ seed: 2 })), over)
  return { source }
}

describe('Email host: the mail already on this computer', () => {
  it('Connect opens the setup, using the accounts shows the real mailbox read-only, and Connect another way comes back', async () => {
    const { default: EmailHost } = await import('./EmailHost')
    render(<EmailHost config={config} onClose={() => undefined} localKit={kit()} />)
    expect(await screen.findByText(/These messages are invented/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use these accounts' }))
    const note = await screen.findByText(/Apple Mail on this computer\./)
    expect(note.parentElement).toHaveTextContent('Read-only')
    expect(screen.queryByText(/These messages are invented/)).toBeNull()
    // Real folders from the account, including Junk, and a real message in the list.
    expect(screen.getAllByRole('button', { name: /Junk/, hidden: true }).length).toBeGreaterThan(0)
    expect(document.querySelector('.mailpane__body')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect another way' }))
    expect(await screen.findByRole('button', { name: 'Use these accounts' })).toBeTruthy()
  })
  it('a mailbox read from a local program offers no server search and says why a typed query only searches here', async () => {
    const { default: EmailHost } = await import('./EmailHost')
    render(<EmailHost config={config} onClose={() => undefined} localKit={kit()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use these accounts' }))
    await screen.findByText(/Apple Mail on this computer\./)
    fireEvent.change(screen.getByLabelText('Search mail'), { target: { value: 'a' } })
    expect(screen.queryByRole('button', { name: /on the server too/ })).toBeNull()
  })
  it('the sign-in route says plainly that it is not wired in the desktop app yet, and leaves the sample in place', async () => {
    const { default: EmailHost } = await import('./EmailHost')
    render(<EmailHost config={config} onClose={() => undefined} localKit={kit()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to an account instead' }))
    expect(await screen.findByText(/not available in the desktop app yet/)).toBeTruthy()
    expect(screen.getByText(/These messages are invented/)).toBeTruthy()
  })
  it('a refused permission shows the Full Disk Access steps, not a dead end', async () => {
    const { default: EmailHost } = await import('./EmailHost')
    render(<EmailHost config={config} onClose={() => undefined} localKit={kit({ unavailable: 'permission_denied' })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    const dlg = await screen.findByRole('group', { name: /needs permission to read Apple Mail/ })
    expect(within(dlg).getByRole('button', { name: 'Sign in to an account instead' })).toBeTruthy()
  })
})
