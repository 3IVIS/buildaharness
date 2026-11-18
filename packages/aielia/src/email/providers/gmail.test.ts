import { describe, it, expect } from 'vitest'
import { GmailEmailProvider } from './gmail.js'
import { GmailFixtureServer } from './gmail-fixture-server.js'
import { FakeEmailProvider } from '../fake-provider.js'
import { PROVIDER_CONFORMANCE_CHECKS } from '../provider-conformance.js'
import { generateSyntheticMailbox } from '../synthetic-mailbox.js'
import { EmailProviderError } from '../provider.js'
import { SignInNeededError } from '../token-source.js'
import { base64ToUtf8, buildRawMessage, decodeEncodedWords, encodeHeaderValue, parseAddressList, parseRawMessage, toBase64Url, utf8ToBase64 } from './mime.js'

const TOKENS = { getAccessToken: async () => 'tok-synthetic' }

function gmail(server = new GmailFixtureServer(generateSyntheticMailbox({ seed: 2 }))) {
  const mailbox = generateSyntheticMailbox({ seed: 2 })
  return { server, provider: new GmailEmailProvider({ account: { ...mailbox.account, provider: 'gmail' }, network: server.port, tokens: TOKENS }) }
}

describe('provider conformance', () => {
  describe('fake provider', () => {
    for (const c of PROVIDER_CONFORMANCE_CHECKS) it(c.name, () => c.run((mb) => new FakeEmailProvider(mb)))
  })
  describe('Gmail over fixtures', () => {
    for (const c of PROVIDER_CONFORMANCE_CHECKS) {
      it(c.name, () => c.run((mb) => gmail(new GmailFixtureServer(mb)).provider))
    }
  })
  it('the suite fails a provider that breaks the contract (negative control)', async () => {
    class Broken extends FakeEmailProvider {
      async markRead(): Promise<void> { /* silently does nothing */ }
    }
    const check = PROVIDER_CONFORMANCE_CHECKS.find((c) => c.name.startsWith('moves, labels'))!
    await expect(check.run((mb) => new Broken(mb))).rejects.toThrow(/provider conformance/)
  })
})

describe('GmailEmailProvider specifics', () => {
  it('sends the bearer token and never puts mail text in a URL', async () => {
    const { server, provider } = gmail()
    await provider.search({ text: 'quarterly report' })
    expect(server.requests.every((r) => r.headers?.authorization === 'Bearer tok-synthetic')).toBe(true)
    expect(server.requests.some((r) => r.url.includes('q=quarterly'))).toBe(true)
  })
  it('maps HTTP failures to provider error codes', async () => {
    const cases: Array<[number, string, string?]> = [[401, 'unauthorized'], [404, 'not_found'], [429, 'rate_limited'], [403, 'rate_limited', JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } })], [403, 'unauthorized'], [400, 'invalid_argument'], [503, 'unavailable']]
    for (const [status, code, body] of cases) {
      const { server, provider } = gmail()
      server.failNext = { status, body }
      await expect(provider.listFolders()).rejects.toMatchObject({ code })
    }
  })
  it('does not copy response text into errors', async () => {
    const { server, provider } = gmail()
    server.failNext = { status: 400, body: JSON.stringify({ error: { message: 'SECRET-MAIL-TEXT-123' } }) }
    const e = await provider.listFolders().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(EmailProviderError)
    expect((e as Error).message).not.toContain('SECRET-MAIL-TEXT')
  })
  it('lets a sign-in problem from the token source propagate unchanged', async () => {
    const { server } = gmail()
    const p = new GmailEmailProvider({ account: generateSyntheticMailbox().account, network: server.port, tokens: { getAccessToken: async () => { throw new SignInNeededError('expired', 'x') } } })
    await expect(p.listFolders()).rejects.toBeInstanceOf(SignInNeededError)
  })
  it('reports a delivered message and an expired history id', async () => {
    const { server, provider } = gmail()
    const t = (await provider.listChanges()).syncToken
    const id = server.deliver({ address: 'z@example.com', name: 'Zed' }, 'New thing', 'body')
    const c = await provider.listChanges(t)
    expect(c.changes).toContainEqual({ type: 'upsert', messageId: id })
    server.expireHistory()
    expect((await provider.listChanges(t)).fullResyncNeeded).toBe(true)
  })
  it('does not carry an HTML body (no sanitiser yet)', async () => {
    const { provider } = gmail()
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    for (const m of (await provider.listMessages(inbox.id)).items) expect(m.htmlBody).toBeUndefined()
  })
  it('moves a bulk selection in one request per 1000 ids', async () => {
    const { server, provider } = gmail()
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    const ids = (await provider.listMessages(inbox.id, { limit: 6 })).items.map((m) => m.id)
    const dest = (await provider.listFolders()).find((f) => f.kind === 'custom')!
    server.requests.length = 0
    await provider.move(ids, dest.id)
    expect(server.requests.filter((r) => r.url.endsWith('/messages/batchModify')).length).toBe(1)
  })
})

describe('mime helpers', () => {
  it('round-trips UTF-8 through base64 and base64url', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'Grüße — ✓ 日本語', 'x'.repeat(1000)]) {
      expect(base64ToUtf8(utf8ToBase64(s))).toBe(s)
      expect(base64ToUtf8(toBase64Url(s))).toBe(s)
    }
    expect(toBase64Url('???>>>')).not.toMatch(/[+/=]/)
  })
  it('encodes and decodes header words', () => {
    expect(encodeHeaderValue('plain')).toBe('plain')
    expect(decodeEncodedWords(encodeHeaderValue('Grüße'))).toBe('Grüße')
    expect(decodeEncodedWords('=?UTF-8?Q?Gr=C3=BC=C3=9Fe_dich?=')).toBe('Grüße dich')
  })
  it('parses address lists with quoted commas and encoded names', () => {
    expect(parseAddressList('"Marlowe, Ada" <ada@example.com>, bob@example.org, =?UTF-8?B?R3LDvMOfZQ==?= <g@example.net>')).toEqual([
      { address: 'ada@example.com', name: 'Marlowe, Ada' }, { address: 'bob@example.org' }, { address: 'g@example.net', name: 'Grüße' },
    ])
  })
  it('strips line breaks from header values (no header injection)', () => {
    const raw = buildRawMessage({ to: [{ address: 'a@example.com' }], subject: 'Hi\r\nBcc: evil@example.net', textBody: 'x' })
    const parsed = parseRawMessage(raw)
    expect(parsed.headers['bcc']).toBeUndefined()
    const raw2 = buildRawMessage({ to: [{ address: 'a@example.com\r\nBcc: evil@example.net', name: 'N\r\nX: y' }], subject: 's', textBody: 'x' })
    expect(parseRawMessage(raw2).headers['bcc']).toBeUndefined()
  })
})

describe('GmailEmailProvider review window hint', () => {
  it('lists only mail received at or after `since`', async () => {
    const { provider } = gmail()
    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox')!
    const all = (await provider.listMessages(inbox.id, { limit: 200 })).items
    const sorted = all.map((m) => m.date).sort()
    const since = sorted[Math.floor(sorted.length / 2)]!
    const cut = (await provider.listMessages(inbox.id, { limit: 200, since })).items
    expect(cut.length).toBeGreaterThan(0)
    expect(cut.length).toBeLessThan(all.length)
    // Gmail's after: operator works in whole seconds, so allow the boundary second.
    for (const m of cut) expect(Date.parse(m.date)).toBeGreaterThanOrEqual(Date.parse(since) - 1000)
  })
})
