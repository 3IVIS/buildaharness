import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resolveConfig, SecretStoreError, SessionFallbackSecretStore } from '@buildaharness/aielia'
import { availableApps, appSwitchHandler } from '../app-switch'
import { EMAIL_CHAT_TOOLS, tauriNetworkPort, tauriSecretStore, NO_KEYRING_PREFIX, type Invoke } from './desktop-platform'

const config = resolveConfig({ llmBackend: 'anthropic', apiKey: 'k' }).config
const platform = vi.fn()
vi.mock('./desktop-platform', async (orig) => ({ ...(await orig<typeof import('./desktop-platform')>()), desktopEmailPlatform: (...a: unknown[]) => platform(...a) }))

afterEach(() => { cleanup(); platform.mockReset() })

describe('Email opened from the desktop app', () => {
  it('is a lazy module in App.tsx, loaded only when the screen opens', async () => {
    const src = (await import('node:fs')).readFileSync('src/App.tsx', 'utf8')
    expect(src).toMatch(/const EmailHost = lazy\(\(\) => import\('\.\/email\/EmailHost'\)\)/)
    expect(src).not.toMatch(/^import .*EmailHost/m)
  })
  it('builds the platform from the app config, shows the mailbox, and goes back to the chat from the drop-down', async () => {
    platform.mockResolvedValue({})
    const { default: EmailHost } = await import('./EmailHost')
    const onClose = vi.fn()
    const onSwitch = vi.fn()
    render(<EmailHost config={config} onClose={onClose} onSwitch={onSwitch} />)
    expect(await screen.findByRole('button', { name: 'Email', expanded: false })).toBeInTheDocument()
    expect(platform).toHaveBeenCalledWith(config)
    await userEvent.click(screen.getByRole('button', { name: 'Email', expanded: false }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Aielia Write/ }))
    expect(onSwitch).toHaveBeenCalledWith('write')
    await userEvent.click(screen.getByRole('button', { name: 'Email', expanded: false }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Aielia Chat/ }))
    expect(onClose).toHaveBeenCalled()
  })
  it('says why it could not start and offers the way back', async () => {
    platform.mockRejectedValue(new Error('no plugin'))
    const { default: EmailHost } = await import('./EmailHost')
    render(<EmailHost config={config} onClose={() => undefined} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Email could not start: no plugin')
    expect(screen.getByRole('button', { name: '← Back to chat' })).toBeInTheDocument()
  })
})

describe('the switcher paths', () => {
  it('names Email on the desktop and, on hosted pages, only the pages the build names (same-site paths)', () => {
    expect(availableApps('chat', { desktopApp: true })).toEqual(['chat', 'write', 'email'])
    expect(availableApps('chat', { desktopApp: false, env: {} })).toEqual(['chat'])
    expect(availableApps('write', { desktopApp: false, env: { VITE_APP_URL_EMAIL: '/email/' } })).toEqual(['write', 'email'])
    expect(availableApps('write', { desktopApp: false, env: { VITE_APP_URL_EMAIL: 'https://evil.example/' } })).toEqual(['write'])
  })
  it('navigates to /email on the hosted pages', () => {
    const navigate = vi.fn()
    appSwitchHandler('chat', { desktopApp: false, navigate, env: { VITE_APP_URL_EMAIL: '/email/' } })!('email')
    expect(navigate).toHaveBeenCalledWith('/email/')
  })
})

describe('the chat inside Email', () => {
  it('has no shell or file tool', () => {
    expect(EMAIL_CHAT_TOOLS).toEqual([])
  })
})

describe('the desktop mail ports', () => {
  it('sends mail requests to the Rust command and hands back the response', async () => {
    const invoke = vi.fn(async () => ({ status: 200, headers: { a: 'b' }, body: 'hi' })) as unknown as Invoke
    const res = await tauriNetworkPort(invoke)({ url: 'https://gmail.googleapis.com/x' })
    expect(invoke).toHaveBeenCalledWith('mail_request', { url: 'https://gmail.googleapis.com/x', method: 'GET', headers: {}, body: null })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hi')
  })
  it('refuses an already cancelled request without calling Rust', async () => {
    const invoke = vi.fn() as unknown as Invoke
    await expect(tauriNetworkPort(invoke)({ url: 'https://x', signal: { aborted: true } })).rejects.toThrow('aborted')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('maps the Rust no-keyring error to a typed error and keeps the token for the session only, never elsewhere', async () => {
    const calls: string[] = []
    const invoke = (async (c: string) => { calls.push(c); throw new Error(`${NO_KEYRING_PREFIX} no secret service`) }) as Invoke
    await expect(tauriSecretStore(invoke).get('a')).rejects.toMatchObject({ code: 'no_keyring' })
    let notices = 0
    const store = new SessionFallbackSecretStore(tauriSecretStore(invoke), () => { notices++ })
    await store.set('a', 'tok')
    expect(await store.get('a')).toBe('tok')
    await store.set('b', 'tok-b')
    expect(store.sessionOnly).toBe(true)
    expect(notices).toBe(1)
    expect(calls).toEqual(['mail_secret_get', 'mail_secret_set']) // after the first miss the keychain is not asked again
    await store.delete('a')
    expect(await store.get('a')).toBeUndefined()
  })

  it('does not fall back on other keychain errors', async () => {
    const invoke = (async () => { throw new Error('keychain error: locked') }) as Invoke
    const store = new SessionFallbackSecretStore(tauriSecretStore(invoke))
    await expect(store.set('a', 'x')).rejects.toMatchObject({ code: 'unavailable' })
    expect(store.sessionOnly).toBe(false)
  })

  it('keeps secrets by account id through the keychain commands, and reports a failure as unavailable', async () => {
    const calls: Array<[string, unknown]> = []
    const invoke = (async (c: string, a: unknown) => { calls.push([c, a]); if (c === 'mail_secret_get') return null; if (c === 'mail_secret_delete') throw new Error('locked'); return undefined }) as Invoke
    const store = tauriSecretStore(invoke)
    expect(await store.get('acct')).toBeUndefined()
    await store.set('acct', 'tok')
    expect(calls).toContainEqual(['mail_secret_set', { accountId: 'acct', value: 'tok' }])
    await expect(store.delete('acct')).rejects.toBeInstanceOf(SecretStoreError)
  })
})
