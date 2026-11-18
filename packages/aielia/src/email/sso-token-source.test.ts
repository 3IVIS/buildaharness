import { describe, it, expect } from 'vitest'
import { SsoInteractionRequired, GRAPH_MAIL_SCOPES, ssoTokenSource, tauriSsoBroker, type SsoBroker } from './sso-token-source.js'
import { SignInNeededError } from './token-source.js'

const broker = (over: Partial<SsoBroker> = {}): SsoBroker & { calls: number } => {
  const b: SsoBroker & { calls: number } = {
    calls: 0, availability: async () => ({ available: true as const }),
    acquireSilently: async () => { b.calls++; return { accessToken: `tok${b.calls}`, expiresAt: b.calls * 1_000_000 } },
    ...over,
  }
  return b
}

describe('ssoTokenSource', () => {
  it('reuses a token until shortly before it expires, then asks the system again', async () => {
    let t = 0
    const b = broker()
    const src = ssoTokenSource(b, { scopes: [...GRAPH_MAIL_SCOPES], now: () => t })
    expect(await src.getAccessToken()).toBe('tok1')
    t = 900_000
    expect(await src.getAccessToken()).toBe('tok1')
    t = 1_000_000 - 30_000
    expect(await src.getAccessToken()).toBe('tok2')
    expect(b.calls).toBe(2)
  })
  it('shares one request between callers at the same moment', async () => {
    const b = broker()
    const src = ssoTokenSource(b, { scopes: ['x'], now: () => 0 })
    const all = await Promise.all([src.getAccessToken(), src.getAccessToken(), src.getAccessToken()])
    expect(new Set(all).size).toBe(1)
    expect(b.calls).toBe(1)
  })
  it('turns "needs the user" into the ordinary sign-in prompt, and any other failure into a missing token', async () => {
    const needs = ssoTokenSource(broker({ acquireSilently: async () => { throw new SsoInteractionRequired() } }), { scopes: ['x'] })
    await expect(needs.getAccessToken()).rejects.toMatchObject({ name: 'SignInNeededError', reason: 'expired' })
    const broke = ssoTokenSource(broker({ acquireSilently: async () => { throw new Error('boom') } }), { scopes: ['x'] })
    await expect(broke.getAccessToken()).rejects.toBeInstanceOf(SignInNeededError)
    const empty = ssoTokenSource(broker({ acquireSilently: async () => ({ accessToken: '', expiresAt: 1 }) }), { scopes: ['x'] })
    await expect(empty.getAccessToken()).rejects.toMatchObject({ reason: 'missing' })
  })
  it('passes the scopes and the account hint, and asks for no sending scope', async () => {
    const seen: unknown[] = []
    const src = ssoTokenSource(broker({ acquireSilently: async (r) => { seen.push(r); return { accessToken: 't', expiresAt: Date.now() + 3_600_000 } } }), { scopes: [...GRAPH_MAIL_SCOPES], accountHint: 'me@example.org' })
    await src.getAccessToken()
    expect(seen[0]).toEqual({ scopes: GRAPH_MAIL_SCOPES, accountHint: 'me@example.org' })
    expect(GRAPH_MAIL_SCOPES.join(' ')).not.toMatch(/Mail\.Send/)
  })
})

describe('tauriSsoBroker', () => {
  it('reports "not built" when the commands answer so, or are missing, and maps interaction-required', async () => {
    expect(await tauriSsoBroker(async () => ({ available: false, reason: 'not_built' }) as never).availability()).toEqual({ available: false, reason: 'not_built' })
    expect(await tauriSsoBroker(async () => { throw new Error('command not found') }).availability()).toEqual({ available: false, reason: 'not_built' })
    await expect(tauriSsoBroker(async () => { throw 'interaction_required: sign in' }).acquireSilently({ scopes: ['x'] })).rejects.toBeInstanceOf(SsoInteractionRequired)
    await expect(tauriSsoBroker(async () => { throw 'sso_unavailable: not_built' }).acquireSilently({ scopes: ['x'] })).rejects.toThrow(/not_built/)
  })
})
