import { describe, it, expect } from 'vitest'
import { OAuthSignIn, OAuthError, GOOGLE_OAUTH_ENDPOINTS, pkceChallenge, type OAuthCrypto } from './oauth.js'
import { InMemorySecretStore } from './secret-store.js'
import { SignInNeededError } from './token-source.js'
import type { NetworkPort, NetworkRequest } from './network.js'

const crypto = (globalThis as unknown as { crypto: OAuthCrypto }).crypto

/** A fake authorisation server: records token requests, answers from a queue. */
function fakeServer(answers: Array<{ status: number; body: unknown }>) {
  const requests: NetworkRequest[] = []
  const port: NetworkPort = async (req) => {
    requests.push(req)
    const a = answers.shift() ?? { status: 500, body: {} }
    return { status: a.status, headers: {}, text: async () => JSON.stringify(a.body) }
  }
  return { requests, port }
}

function setup(answers: Array<{ status: number; body: unknown }>, clock = { t: 1_000_000 }) {
  const server = fakeServer(answers)
  const secrets = new InMemorySecretStore()
  const flow = new OAuthSignIn({
    accountId: 'acct-1',
    endpoints: GOOGLE_OAUTH_ENDPOINTS,
    clientId: 'client-synthetic',
    redirectUri: 'https://app.example.test/callback',
    network: server.port,
    secrets,
    crypto,
    now: () => clock.t,
  })
  return { server, secrets, flow, clock }
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!

describe('OAuth sign-in with PKCE', () => {
  it('builds a consent address with S256 challenge and state, and exchanges the code with the verifier', async () => {
    const { flow, server } = setup([{ status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' } }])
    const { authorizationUrl } = await flow.begin()
    const u = new URL(authorizationUrl)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('client_id')).toBe('client-synthetic')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.test/callback')
    const tokens = await flow.complete(`https://app.example.test/callback?code=abc&state=${stateOf(authorizationUrl)}`)
    const body = new URLSearchParams(server.requests[0]!.body)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('abc')
    expect(await pkceChallenge(body.get('code_verifier')!, crypto)).toBe(u.searchParams.get('code_challenge'))
    expect(await tokens.getAccessToken()).toBe('at-1')
  })

  it('rejects a wrong state without calling the token endpoint', async () => {
    const { flow, server } = setup([])
    await flow.begin()
    await expect(flow.complete('https://app.example.test/callback?code=abc&state=forged')).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(server.requests).toHaveLength(0)
  })

  it('reports denied consent', async () => {
    const { flow, server } = setup([])
    const { authorizationUrl } = await flow.begin()
    await expect(flow.complete(`https://app.example.test/callback?error=access_denied&state=${stateOf(authorizationUrl)}`)).rejects.toMatchObject({ code: 'denied' })
    expect(server.requests).toHaveLength(0)
  })

  it('allows one attempt per begin: a replayed redirect finds no sign-in in progress', async () => {
    const { flow } = setup([{ status: 200, body: { access_token: 'a', expires_in: 60 } }])
    const { authorizationUrl } = await flow.begin()
    const redirect = `https://app.example.test/callback?code=abc&state=${stateOf(authorizationUrl)}`
    await flow.complete(redirect)
    await expect(flow.complete(redirect)).rejects.toMatchObject({ code: 'no_pending_sign_in' })
  })

  it('a failed exchange is an OAuthError that carries no code or token text', async () => {
    const { flow } = setup([{ status: 400, body: { error: 'invalid_grant', detail: 'code-secret-xyz' } }])
    const { authorizationUrl } = await flow.begin()
    const err = await flow.complete(`https://app.example.test/callback?code=code-secret-xyz&state=${stateOf(authorizationUrl)}`).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('exchange_failed')
    expect((err as Error).message).not.toContain('code-secret-xyz')
  })

  it('refreshes an expired access token when a refresh token exists, and keeps a rotated one', async () => {
    const { flow, server, clock } = setup([
      { status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' } },
      { status: 200, body: { access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' } },
      { status: 200, body: { access_token: 'at-3', expires_in: 3600 } },
    ])
    const { authorizationUrl } = await flow.begin()
    const tokens = await flow.complete(`https://app.example.test/callback?code=c&state=${stateOf(authorizationUrl)}`)
    expect(await tokens.getAccessToken()).toBe('at-1')
    clock.t += 4_000_000
    expect(await tokens.getAccessToken()).toBe('at-2')
    expect(new URLSearchParams(server.requests[1]!.body).get('refresh_token')).toBe('rt-1')
    clock.t += 4_000_000
    expect(await (await flow.tokenSource()).getAccessToken()).toBe('at-3')
    expect(new URLSearchParams(server.requests[2]!.body).get('refresh_token')).toBe('rt-2')
  })

  it('needs sign-in again when there is no refresh token and the access token expired', async () => {
    const { flow, clock } = setup([{ status: 200, body: { access_token: 'at-1', expires_in: 3600 } }])
    const { authorizationUrl } = await flow.begin()
    const tokens = await flow.complete(`https://app.example.test/callback?code=c&state=${stateOf(authorizationUrl)}`)
    expect(await tokens.getAccessToken()).toBe('at-1')
    clock.t += 4_000_000
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(SignInNeededError)
  })

  it('needs sign-in when the provider rejects the refresh token, and clears the stored token', async () => {
    const { flow, secrets, clock } = setup([
      { status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ])
    const { authorizationUrl } = await flow.begin()
    const tokens = await flow.complete(`https://app.example.test/callback?code=c&state=${stateOf(authorizationUrl)}`)
    clock.t += 4_000_000
    await expect(tokens.getAccessToken()).rejects.toMatchObject({ reason: 'refresh_rejected' })
    expect(await secrets.get('acct-1')).toBeUndefined()
    await expect(flow.tokenSource()).rejects.toBeInstanceOf(SignInNeededError)
  })

  it('tokenSource() throws sign-in needed when nothing is stored', async () => {
    const { flow } = setup([])
    await expect(flow.tokenSource()).rejects.toMatchObject({ reason: 'missing' })
  })

  it('computes the RFC 7636 S256 example challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', crypto)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
