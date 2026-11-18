import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { generateSyntheticMailbox, type SyntheticMailbox } from './synthetic-mailbox.js'
import { syncForWindow, windowSince } from './review-window.js'
import { searchMail } from './mail-search.js'
import { runMailReadTool } from './mail-tools.js'
import { EmailProviderError, type EmailProvider } from './provider.js'
import { GmailEmailProvider } from './providers/gmail.js'
import { GmailFixtureServer } from './providers/gmail-fixture-server.js'
import { GraphEmailProvider } from './providers/graph.js'
import { GraphFixtureServer } from './providers/graph-fixture-server.js'
import { ImapEmailProvider } from './providers/imap.js'
import { ImapFixtureServer } from './providers/imap-fixture-server.js'
import type { SettingsStore } from '../writer/write-permissions.js'
import type { Message } from './model.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const SINCE = windowSince(7, NOW)!
const TOKENS = { getAccessToken: async () => 'tok' }
const store = (): SettingsStore => { const m = new Map<string, unknown>(); return { getSetting: async (k) => m.get(k), setSetting: async (k, v) => { m.set(k, v) } } }
const mailbox = (): SyntheticMailbox => generateSyntheticMailbox({ seed: 7, perCategory: 6 })

const PROVIDERS: Array<[string, (mb: SyntheticMailbox) => EmailProvider]> = [
  ['fake', (mb) => new FakeEmailProvider(mb)],
  ['Gmail fixtures', (mb) => new GmailEmailProvider({ account: { ...mb.account, provider: 'gmail' }, network: new GmailFixtureServer(mb).port, tokens: TOKENS })],
  ['Graph fixtures', (mb) => new GraphEmailProvider({ account: { ...mb.account, provider: 'graph' }, network: new GraphFixtureServer(mb).port, tokens: TOKENS })],
  ['IMAP fixtures', (mb) => { let n = 0; return new ImapEmailProvider({ account: { ...mb.account, provider: 'imap' }, transport: new ImapFixtureServer(mb), newId: () => `t${++n}`, now: () => NOW }) }],
]

/** A message older than the window whose subject no other message shares: the target a local-only search cannot see. */
function target(mb: SyntheticMailbox): Message {
  const subjects = new Map<string, number>()
  for (const m of mb.messages) subjects.set(m.subject, (subjects.get(m.subject) ?? 0) + 1)
  const t = mb.messages.find((m) => m.date < SINCE && subjects.get(m.subject) === 1 && m.folderIds.includes('fld-inbox'))
  if (!t) throw new Error('fixture has no unique old message')
  return t
}

describe.each(PROVIDERS)('server search recall over %s', (_name, make) => {
  it('finds mail older than the review window that local search cannot (control: local-only fails)', async () => {
    const mb = mailbox(), t = target(mb)
    const p = make(mb), cache = new InMemoryEmailCache()
    await syncForWindow(p, cache, store(), 7, { now: NOW })
    const base = { account: p.account, cache, windowSince: SINCE }
    // Compared by subject: an IMAP provider names messages by their Message-ID header, not by the fixture's ids.
    // Control arm.
    const local = await searchMail({ text: t.subject }, 'local', { ...base, provider: p })
    expect(local.hits.map((h) => h.message.subject)).not.toContain(t.subject)
    // Candidate arm.
    const both = await searchMail({ text: t.subject }, 'both', { ...base, provider: p })
    const hit = both.hits.find((h) => h.message.subject === t.subject)
    expect(hit, 'server hit').toBeDefined()
    expect(hit).toMatchObject({ source: 'server', outsideWindow: true })
    expect(both.scopeUsed).toBe('both')
    // Cached, so it opens fast next time.
    expect(await cache.getMessage(hit!.message.id)).toBeDefined()
  })
})

describe('scope routing', () => {
  async function setup() {
    const mb = mailbox(), t = target(mb)
    const p = new FakeEmailProvider(mb), cache = new InMemoryEmailCache()
    await syncForWindow(p, cache, store(), 7, { now: NOW })
    let calls = 0
    const spy: Pick<EmailProvider, 'search'> = { search: (q, o) => { calls++; return p.search(q, o) } }
    return { mb, t, p, cache, spy, calls: () => calls, base: { account: p.account, cache, windowSince: SINCE, provider: spy } }
  }
  it('local never touches the server; auto stays local when the local answer is full and in-window', async () => {
    const s = await setup()
    const inWindow = s.mb.messages.find((m) => m.date >= SINCE && m.folderIds.includes('fld-inbox'))!
    await searchMail({ text: s.t.subject }, 'local', s.base)
    expect(s.calls()).toBe(0)
    const r = await searchMail({ from: inWindow.from.address }, 'auto', { ...s.base, thinBelow: 1 })
    expect(r.scopeUsed).toBe('local')
    expect(s.calls()).toBe(0)
  })
  it('auto asks the server when the local answer is thin, or when the dates reach back past the window', async () => {
    const s = await setup()
    const thin = await searchMail({ text: s.t.subject }, 'auto', s.base)
    expect(thin.scopeUsed).toBe('both')
    expect(thin.hits.some((h) => h.message.id === s.t.id)).toBe(true)
    const before = s.calls()
    await searchMail({ after: '2026-09-01T00:00:00.000Z', before: '2026-10-01T00:00:00.000Z' }, 'auto', { ...s.base, thinBelow: 0 })
    expect(s.calls()).toBeGreaterThan(before)
  })
  it('merges without duplicates: a message both local and on the server appears once, as local', async () => {
    const s = await setup()
    const inWindow = s.mb.messages.find((m) => m.date >= SINCE && m.folderIds.includes('fld-inbox'))!
    const r = await searchMail({ text: inWindow.subject }, 'both', s.base)
    const ids = r.hits.map((h) => h.message.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(r.hits.find((h) => h.message.id === inWindow.id)).toMatchObject({ source: 'local', outsideWindow: false })
  })
  it('a server error or rate limit returns the local hits with the reason; no provider says so', async () => {
    const s = await setup()
    const limited: Pick<EmailProvider, 'search'> = { search: async () => { throw new EmailProviderError('rate_limited', 'slow down') } }
    const inWindow = s.mb.messages.find((m) => m.date >= SINCE && m.folderIds.includes('fld-inbox'))!
    const r = await searchMail({ text: inWindow.subject }, 'both', { ...s.base, provider: limited })
    expect(r.serverError).toEqual({ code: 'rate_limited', message: 'slow down' })
    expect(r.hits.length).toBeGreaterThan(0)
    const offline: Pick<EmailProvider, 'search'> = { search: async () => { throw new Error('network down') } }
    expect((await searchMail({ text: 'x' }, 'server', { ...s.base, provider: offline })).serverError?.code).toBe('offline')
    const none = await searchMail({ text: s.t.subject }, 'both', { ...s.base, provider: undefined })
    expect(none.serverUnavailable).toBe(true)
  })
  it('excluded senders are withheld from server hits too, and counted', async () => {
    const s = await setup()
    const r = await searchMail({ text: s.t.subject }, 'server', { ...s.base, accept: (m) => m.from.address !== s.t.from.address })
    expect(r.hits.map((h) => h.message.id)).not.toContain(s.t.id)
    expect(r.withheld).toBeGreaterThan(0)
    expect(await s.cache.getMessage(s.t.id)).toBeUndefined()
  })
})

describe('mail_search tool', () => {
  async function deps(extra: { excludedSenders?: string[]; provider?: boolean } = {}) {
    const mb = mailbox(), t = target(mb)
    const p = new FakeEmailProvider(mb), cache = new InMemoryEmailCache()
    await syncForWindow(p, cache, store(), 7, { now: NOW })
    return { t, mb, cache, d: { account: { ...p.account, aieliaMayRead: true, excludedSenders: extra.excludedSenders ?? [] }, cache, context: { chips: [] }, ...(extra.provider === false ? {} : { provider: p }), windowSince: SINCE } }
  }
  it('says when the server was searched and marks mail older than the window', async () => {
    const { t, d } = await deps()
    const r = await runMailReadTool('mail_search', { text: t.subject, scope: 'both' }, d as never)
    expect(r.ok).toBe(true)
    expect(r.text).toContain(t.id)
    expect(r.text).toMatch(/older than your review window/)
    expect(r.text).toMatch(/server was searched too/)
    expect(r.citations.some((c) => c.messageId === t.id)).toBe(true)
  })
  it('wraps nothing of an excluded sender, and refuses an unknown scope', async () => {
    const { t, d } = await deps()
    const ex = { ...d, account: { ...d.account, excludedSenders: [t.from.address] } }
    const r = await runMailReadTool('mail_search', { text: t.subject, scope: 'server' }, ex as never)
    expect(r.text).not.toContain(t.subject)
    expect(r.text).toMatch(/not shown: excluded/)
    expect((await runMailReadTool('mail_search', { scope: 'everywhere' }, d as never)).ok).toBe(false)
  })
  it('reports a failing server and the local-only answer', async () => {
    const { d } = await deps()
    const bad = { ...d, provider: { search: async () => { throw new EmailProviderError('unavailable', 'down') } } }
    const r = await runMailReadTool('mail_search', { text: 'zzz-nothing', scope: 'server' }, bad as never)
    expect(r.text).toMatch(/could not be searched \(unavailable\)/)
  })
  it('without a provider the tool says only this device was searched', async () => {
    const { t, d } = await deps({ provider: false })
    const r = await runMailReadTool('mail_search', { text: t.subject, scope: 'both' }, d as never)
    expect(r.text).toMatch(/not reachable from here/)
  })
})
