import { describe, it, expect } from 'vitest'
import { GraphEmailProvider, GRAPH_API_BASE, GRAPH_FOLDER_CATEGORY_PREFIX } from './graph.js'
import { GraphFixtureServer } from './graph-fixture-server.js'
import { PROVIDER_CONFORMANCE_CHECKS } from '../provider-conformance.js'
import { generateSyntheticMailbox } from '../synthetic-mailbox.js'
import { EmailProviderError } from '../provider.js'
import { SignInNeededError } from '../token-source.js'
import { OAuthSignIn, MICROSOFT_OAUTH_ENDPOINTS, type OAuthCrypto } from '../oauth.js'
import { InMemorySecretStore } from '../secret-store.js'
import type { NetworkPort, NetworkRequest } from '../network.js'

const TOKENS = { getAccessToken: async () => 'tok-synthetic' }

function graph(server = new GraphFixtureServer(generateSyntheticMailbox({ seed: 2 }))) {
  const mailbox = generateSyntheticMailbox({ seed: 2 })
  return { server, provider: new GraphEmailProvider({ account: { ...mailbox.account, provider: 'graph' }, network: server.port, tokens: TOKENS }) }
}

describe('Graph provider conformance', () => {
  for (const c of PROVIDER_CONFORMANCE_CHECKS) {
    it(c.name, () => c.run((mb) => graph(new GraphFixtureServer(mb)).provider))
  }
})

describe('GraphEmailProvider specifics', () => {
  it('sends the bearer token and immutable-id preference, and keeps mail text out of the path', async () => {
    const { server, provider } = graph()
    await provider.search({ text: 'quarterly report' })
    expect(server.requests.every((r) => r.headers?.authorization === 'Bearer tok-synthetic')).toBe(true)
    expect(server.requests.every((r) => (r.headers?.prefer ?? '').includes('ImmutableId'))).toBe(true)
    expect(server.requests.some((r) => decodeURIComponent(r.url).includes('$search="quarterly report"'))).toBe(true)
  })
  it('maps HTTP failures to provider error codes', async () => {
    const cases: Array<[number, string]> = [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [410, 'not_found'], [429, 'rate_limited'], [400, 'invalid_argument'], [503, 'unavailable']]
    for (const [status, code] of cases) {
      const { server, provider } = graph()
      server.failNext = { status, body: '{}' }
      await expect(provider.listFolders()).rejects.toMatchObject({ code })
    }
  })
  it('does not copy response text into errors', async () => {
    const { server, provider } = graph()
    server.failNext = { status: 400, body: JSON.stringify({ error: { message: 'SECRET-MAIL-TEXT-123' } }) }
    const e = await provider.listFolders().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(EmailProviderError)
    expect((e as Error).message).not.toContain('SECRET-MAIL-TEXT')
  })
  it('lets a sign-in problem from the token source propagate unchanged', async () => {
    const { server } = graph()
    const p = new GraphEmailProvider({ account: generateSyntheticMailbox().account, network: server.port, tokens: { getAccessToken: async () => { throw new SignInNeededError('expired', 'x') } } })
    await expect(p.listFolders()).rejects.toBeInstanceOf(SignInNeededError)
  })
  it('never follows a page token that points outside the API (the access token stays with Graph)', async () => {
    const { server, provider } = graph()
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    server.requests.length = 0
    await expect(provider.listMessages(inbox.id, { pageToken: 'https://evil.example.net/steal' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(provider.listChanges(JSON.stringify({ x: 'https://evil.example.net/delta' }))).resolves.toMatchObject({ fullResyncNeeded: true })
    expect(server.requests.some((r) => r.url.startsWith('https://evil.example.net'))).toBe(false)
  })
  it('reports a delivered message, a deleted message and an expired delta link', async () => {
    const { server, provider } = graph()
    const t = (await provider.listChanges()).syncToken
    const id = server.deliver({ address: 'z@example.com', name: 'Zed' }, 'New thing', 'body')
    const c = await provider.listChanges(t)
    expect(c.changes).toContainEqual({ type: 'upsert', messageId: id })
    server.expireDelta()
    expect((await provider.listChanges(c.syncToken)).fullResyncNeeded).toBe(true)
  })
  it('a moved message is one upsert, not a delete', async () => {
    const { provider } = graph()
    const folders = await provider.listFolders()
    const inbox = folders.find((f) => f.kind === 'inbox')!
    const dest = folders.find((f) => f.kind === 'custom')!
    const msg = (await provider.listMessages(inbox.id, { limit: 3 })).items[0]!
    const t = (await provider.listChanges()).syncToken
    await provider.move([msg.id], dest.id)
    const c = await provider.listChanges(t)
    expect(c.changes.filter((x) => x.messageId === msg.id)).toEqual([{ type: 'upsert', messageId: msg.id }])
  })
  it('asks for a full resync when a folder appears or the token is not a delta map', async () => {
    const { server, provider } = graph()
    const t = (await provider.listChanges()).syncToken
    server.addChildFolder('Projects', 'Sub')
    expect((await provider.listChanges(t)).fullResyncNeeded).toBe(true)
    expect((await provider.listChanges('not json')).fullResyncNeeded).toBe(true)
  })
  it('lists nested folders with their parent and carries attachments', async () => {
    const { server, provider } = graph()
    const sub = server.addChildFolder('Projects', 'Sub')
    const folders = await provider.listFolders()
    expect(folders.find((f) => f.id === sub)).toMatchObject({ name: 'Sub', kind: 'custom', parentId: folders.find((f) => f.name === 'Projects')!.id })
    const inbox = folders.find((f) => f.kind === 'inbox')!
    const msg = (await provider.listMessages(inbox.id, { limit: 1 })).items[0]!
    server.attach(msg.id, 'plan.pdf', 'application/pdf', 1234)
    expect((await provider.getMessage(msg.id)).attachments).toEqual([{ id: expect.any(String), filename: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }])
  })
  it('keeps extra folder memberships as categories and a move clears them', async () => {
    const { server, provider } = graph()
    const folders = await provider.listFolders()
    const inbox = folders.find((f) => f.kind === 'inbox')!
    const dest = folders.find((f) => f.kind === 'custom')!
    const msg = (await provider.listMessages(inbox.id, { limit: 1 })).items[0]!
    await provider.label([msg.id], dest.id, true)
    expect((await provider.getMessage(msg.id)).folderIds).toEqual([inbox.id, dest.id])
    expect(JSON.stringify(server.requests.filter((r) => r.method === 'PATCH').map((r) => r.body))).toContain(`${GRAPH_FOLDER_CATEGORY_PREFIX}${dest.id}`)
    await provider.move([msg.id], folders.find((f) => f.kind === 'archive')!.id)
    expect((await provider.getMessage(msg.id)).folderIds).toHaveLength(1)
  })
  it('send finds the sent copy by internet message id, which has a new id', async () => {
    const { server, provider } = graph()
    const d = await provider.createDraft({ to: [{ address: 'x@example.com' }], bcc: [{ address: 'hidden@example.com' }], subject: 'S', textBody: 'B' })
    const sent = await provider.send(d.id)
    expect(sent.id).not.toBe(d.id)
    expect(sent.headers['message-id']).toBe(d.headers['message-id'])
    expect(sent.flags.draft).toBe(false)
    expect(server.count('drafts')).toBe((await provider.listMessages((await provider.listFolders()).find((f) => f.kind === 'drafts')!.id)).items.length)
  })
  it('send reports success when the sent copy is not visible yet, so a retry cannot double-send', async () => {
    const { server, provider } = graph()
    const d = await provider.createDraft({ to: [{ address: 'x@example.com' }], subject: 'S', textBody: 'B' })
    const inner = server.port
    const blind: NetworkPort = async (req: NetworkRequest) => (decodeURIComponent(req.url).includes('internetMessageId eq') ? { status: 200, headers: {}, text: async () => '{"value":[]}' } : inner(req))
    const p2 = new GraphEmailProvider({ account: generateSyntheticMailbox().account, network: blind, tokens: TOKENS })
    const sent = await p2.send(d.id)
    expect(sent.flags.draft).toBe(false)
  })
  it('does not carry an HTML body when Graph sends one', async () => {
    const { server } = graph()
    const inner = server.port
    const html: NetworkPort = async (req) => {
      const res = await inner(req)
      const text = (await res.text()).split('"contentType":"text"').join('"contentType":"html"')
      return { ...res, text: async () => text }
    }
    const p = new GraphEmailProvider({ account: generateSyntheticMailbox().account, network: html, tokens: TOKENS })
    const inbox = (await p.listFolders()).find((f) => f.kind === 'inbox')!
    for (const m of (await p.listMessages(inbox.id)).items) {
      expect(m.htmlBody).toBeUndefined()
      expect(m.textBody).not.toContain('<')
    }
  })
  it('permanent deletion uses permanentDelete only for a message already in trash', async () => {
    const { server, provider } = graph()
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    const msg = (await provider.listMessages(inbox.id, { limit: 1 })).items[0]!
    server.requests.length = 0
    await provider.delete([msg.id])
    expect(server.requests.some((r) => r.url.endsWith('/permanentDelete'))).toBe(false)
    await provider.delete([msg.id])
    expect(server.requests.some((r) => r.url.endsWith('/permanentDelete'))).toBe(true)
  })
  it('the conformance suite fails a Graph provider that drops a change (negative control)', async () => {
    class Broken extends GraphEmailProvider {
      async markRead(): Promise<void> { /* silently does nothing */ }
    }
    const check = PROVIDER_CONFORMANCE_CHECKS.find((c) => c.name.startsWith('moves, labels'))!
    await expect(check.run((mb) => new Broken({ account: generateSyntheticMailbox().account, network: new GraphFixtureServer(mb).port, tokens: TOKENS }))).rejects.toThrow(/provider conformance/)
  })
  it('exports an API base the fixture and provider agree on', () => {
    expect(GRAPH_API_BASE).toBe('https://graph.microsoft.com/v1.0')
  })
})

describe('Microsoft sign-in (PKCE, rotating refresh tokens)', () => {
  const crypto = (globalThis as unknown as { crypto: OAuthCrypto }).crypto
  function setup(answers: Array<{ status: number; body: unknown }>) {
    const requests: NetworkRequest[] = []
    const network: NetworkPort = async (req) => {
      requests.push(req)
      const a = answers.shift() ?? { status: 500, body: {} }
      return { status: a.status, headers: {}, text: async () => JSON.stringify(a.body) }
    }
    const clock = { t: 1_000_000 }
    const secrets = new InMemorySecretStore()
    const flow = new OAuthSignIn({ accountId: 'acct-ms', endpoints: MICROSOFT_OAUTH_ENDPOINTS, clientId: 'client-synthetic', redirectUri: 'https://app.example.test/callback', network, secrets, crypto, now: () => clock.t })
    return { requests, secrets, flow, clock }
  }
  it('asks for mail scopes and a refresh token, with PKCE and no client secret', async () => {
    const { flow, requests } = setup([{ status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' } }])
    const { authorizationUrl } = await flow.begin()
    const u = new URL(authorizationUrl)
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(u.searchParams.get('scope')).toContain('Mail.ReadWrite')
    expect(u.searchParams.get('scope')).toContain('offline_access')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    await flow.complete(`https://app.example.test/callback?code=abc&state=${u.searchParams.get('state')}`)
    const body = new URLSearchParams(requests[0]!.body)
    expect(body.get('client_secret')).toBeNull()
    expect(body.get('code_verifier')).toBeTruthy()
  })
  it('keeps the rotated refresh token, and a rejected one means sign in again', async () => {
    const { flow, requests, secrets, clock } = setup([
      { status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' } },
      { status: 200, body: { access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ])
    const { authorizationUrl } = await flow.begin()
    const tokens = await flow.complete(`https://app.example.test/callback?code=abc&state=${new URL(authorizationUrl).searchParams.get('state')}`)
    clock.t += 3_600_000
    expect(await tokens.getAccessToken()).toBe('at-2')
    expect(new URLSearchParams(requests[1]!.body).get('refresh_token')).toBe('rt-1')
    expect(JSON.parse((await secrets.get('acct-ms'))!).refreshToken).toBe('rt-2')
    clock.t += 3_600_000
    await expect(tokens.getAccessToken()).rejects.toMatchObject({ reason: 'refresh_rejected' })
    expect(requests[2]!.url).toBe(MICROSOFT_OAUTH_ENDPOINTS.tokenEndpoint)
    expect(new URLSearchParams(requests[2]!.body).get('refresh_token')).toBe('rt-2')
  })
})
