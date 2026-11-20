import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FixtureLocalSource, generateSyntheticMailbox, type LocalDiscovery } from '@buildaharness/aielia'
import { LocalMailSetup } from './LocalMailSetup'

afterEach(cleanup)
const denied = (): FixtureLocalSource => Object.assign(new FixtureLocalSource(generateSyntheticMailbox({ seed: 2 })), { discover: async (): Promise<LocalDiscovery> => ({ available: false, reason: 'permission_denied', accounts: [], messageCount: 0 }) })

describe('the permission screen', () => {
  it('names the app as macOS lists it, and offers to open the settings, show the app in Finder, and restart it', async () => {
    const open = vi.fn(), reveal = vi.fn(), restart = vi.fn()
    render(<LocalMailSetup source={denied()} appName="AieliaEmail" openFullDiskAccessSettings={open} revealApp={reveal} restartApp={restart} onUse={() => undefined} onSignIn={() => undefined} onCancel={() => undefined} />)
    expect(await screen.findByText('AieliaEmail', { selector: 'strong' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show AieliaEmail in Finder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart AieliaEmail' }))
    expect([open, reveal, restart].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
    // Never a dead end.
    expect(screen.getByRole('button', { name: 'Sign in to an account instead' })).toBeTruthy()
  })
  it('says the permission applies only after a restart', async () => {
    render(<LocalMailSetup source={denied()} onUse={() => undefined} onSignIn={() => undefined} onCancel={() => undefined} />)
    expect(await screen.findByText(/applies the permission only when an app starts/)).toBeTruthy()
  })
})
