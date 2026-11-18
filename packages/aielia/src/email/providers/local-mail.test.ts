import { describe, it, expect } from 'vitest'
import { LocalMailProvider, isLocalOnlyAccount, type LocalMailActions, type LocalMessageRef } from './local-mail.js'
import { FIXTURE_LOCAL_ACCOUNT, FixtureLocalSource } from '../local-fixture-source.js'
import { LocalSourceError, classifyLocalFolder, mapLocalSourceError } from '../local-source.js'
import { PROVIDER_CONFORMANCE_CHECKS } from '../provider-conformance.js'
import { generateSyntheticMailbox, type SyntheticMailbox } from '../synthetic-mailbox.js'
import { EmailProviderError } from '../provider.js'
import { InMemoryEmailCache } from '../cache.js'
import { syncAccount } from '../sync.js'
import { syncForWindow, windowSince } from '../review-window.js'
import type { SettingsStore } from '../../writer/write-permissions.js'

const make = (mb: SyntheticMailbox = generateSyntheticMailbox({ seed: 2 }), actions?: LocalMailActions, opts: { partialEvery?: number } = {}) => {
  const source = new FixtureLocalSource(mb, opts)
  const provider = new LocalMailProvider({ account: { ...mb.account, provider: 'apple_mail' }, source, localAccountId: FIXTURE_LOCAL_ACCOUNT, ...(actions ? { actions } : {}) })
  return { source, provider, mb }
}
const store = (): SettingsStore => { const m = new Map<string, unknown>(); return { getSetting: async (k) => m.get(k), setSetting: async (k, v) => { m.set(k, v) } } }
const READ_CHECKS = ['lists folders with kinds and unread counts', 'pages messages without repeats, and pages threads', 'fetches a message and its thread; unknown ids are not_found', 'returns copies, not live state', 'asks for a full resync when the token is unknown']

describe('provider conformance: the read-only checks (changes, drafts, send and delete are not offered by this provider)', () => {
  for (const name of READ_CHECKS) {
    const c = PROVIDER_CONFORMANCE_CHECKS.find((x) => x.name === name)!
    it(name, () => c.run((mb) => make(mb).provider))
  }
})

describe('LocalMailProvider reading', () => {
  it('names folders by the program\'s own folder names, with kinds and unread counts', async () => {
    const { provider } = make()
    const f = await provider.listFolders()
    expect(f.map((x) => x.kind).sort()).toEqual(expect.arrayContaining(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'custom']))
    expect(f.every((x) => /^m\d+$/.test(x.id) && x.accountId === provider.account.id)).toBe(true)
    expect(classifyLocalFolder(['[Gmail]', 'All Mail'])).toBe('archive')
    expect(classifyLocalFolder(['Sent Messages'])).toBe('sent')
    expect(classifyLocalFolder(['Receipts 2025'])).toBe('custom')
  })
  it('builds messages from the raw copy: headers, recipients, threading headers and the body', async () => {
    const { provider } = make()
    const inbox = (await provider.listFolders()).find((x) => x.kind === 'inbox')!
    const m = (await provider.listMessages(inbox.id, { limit: 50 })).items[0]!
    expect(m.id).toMatch(/^a\d+$/)
    expect(m.threadId).toMatch(/^c\d+$/)
    expect(m.textBody.length).toBeGreaterThan(0)
    expect(m.to.length).toBeGreaterThan(0)
    expect(m.headers['message-id']).toMatch(/^<.+>$/)
    expect(m.folderIds).toEqual([inbox.id])
  })
  it('a body the program never downloaded shows its headers and says so', async () => {
    const { provider } = make(undefined, undefined, { partialEvery: 2 })
    const inbox = (await provider.listFolders()).find((x) => x.kind === 'inbox')!
    const items = (await provider.listMessages(inbox.id, { limit: 50 })).items
    const partial = items.filter((m) => m.headers['x-aielia-body'] === 'not-downloaded')
    expect(partial.length).toBeGreaterThan(0)
    for (const m of partial) { expect(m.textBody).toBe(''); expect(m.subject.length).toBeGreaterThan(0) }
    expect(items.some((m) => !m.headers['x-aielia-body'])).toBe(true)
  })
  it('honours the review window natively (a dated query, no bodies read outside it)', async () => {
    const { provider, source, mb } = make()
    const inbox = (await provider.listFolders()).find((x) => x.kind === 'inbox')!
    const dates = mb.messages.filter((m) => m.folderIds.includes('fld-inbox')).map((m) => m.date).sort()
    const since = dates[Math.floor(dates.length / 2)]!
    const before = source.calls.body
    const cut = (await provider.listMessages(inbox.id, { limit: 200, since })).items
    expect(cut.length).toBeGreaterThan(0)
    expect(cut.length).toBeLessThan(dates.length)
    for (const m of cut) expect(m.date >= since.slice(0, 19)).toBe(true)
    expect(source.calls.body - before).toBe(cut.length)
  })
  it('threads by the program\'s conversation id, across folders, and getThread finds the Sent copy too', async () => {
    const { provider, mb } = make()
    const t = mb.threads.find((x) => x.messageIds.length > 1) ?? mb.threads[0]!
    const all = await provider.listFolders()
    const some = (await provider.listMessages(all.find((f) => f.kind === 'inbox')!.id, { limit: 100 })).items[0]!
    const { thread, messages } = await provider.getThread(some.threadId)
    expect(messages.every((m) => m.threadId === some.threadId)).toBe(true)
    expect(thread.messageIds.length).toBe(messages.length)
    expect(t).toBeDefined()
    await expect(provider.getThread('c999999')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('lists threads from rows alone (no body is read)', async () => {
    const { provider, source } = make()
    const inbox = (await provider.listFolders()).find((x) => x.kind === 'inbox')!
    const th = await provider.listThreads(inbox.id, { limit: 5 })
    expect(th.items.length).toBe(5)
    expect(source.calls.body).toBe(0)
  })
  it('searches subject and sender, scoped to the account\'s own mailboxes', async () => {
    const { provider, mb } = make()
    const subj = mb.messages.find((m) => m.folderIds.includes('fld-inbox'))!.subject
    const hits = await provider.search({ text: subj })
    expect(hits.items.some((m) => m.subject === subj)).toBe(true)
    expect((await provider.search({ text: 'zzz-no-such-subject-qqq' })).items).toHaveLength(0)
    const other = new LocalMailProvider({ account: provider.account, source: new FixtureLocalSource(mb), localAccountId: 'some-other-account' })
    expect((await other.listFolders())).toHaveLength(0)
    expect((await other.search({ text: subj })).items).toHaveLength(0)
  })
  it('is local-only: the shared search knows it has no server', () => {
    expect(isLocalOnlyAccount({ provider: 'apple_mail' })).toBe(true)
    expect(isLocalOnlyAccount({ provider: 'gmail' })).toBe(false)
  })
})

describe('writes, sending and deleting', () => {
  it('without automation every change is refused with a plain reason, and nothing is sent or deleted', async () => {
    const { provider } = make()
    const inbox = (await provider.listFolders()).find((x) => x.kind === 'inbox')!
    const m = (await provider.listMessages(inbox.id, { limit: 1 })).items[0]!
    for (const run of [() => provider.move([m.id], inbox.id), () => provider.markRead([m.id], true), () => provider.flag([m.id], true), () => provider.createDraft({ to: [{ address: 'x@example.com' }], subject: 's', textBody: 'b' }), () => provider.label([m.id], inbox.id, true)]) {
      await expect(run()).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    await expect(provider.send('x')).rejects.toThrow(/send it yourself/)
    await expect(provider.delete([m.id])).rejects.toThrow(/always done in your mail program/)
  })
  it('with automation, changes carry the mailbox path and the Message-ID; send and delete stay refused', async () => {
    const calls: Array<{ op: string; refs?: LocalMessageRef[]; dest?: string[]; flag?: boolean; account?: string }> = []
    const actions: LocalMailActions = {
      async move(refs, dest) { calls.push({ op: 'move', refs, dest }) }, async setRead(refs, read) { calls.push({ op: 'read', refs, flag: read }) },
      async setFlagged(refs, f) { calls.push({ op: 'flag', refs, flag: f }) }, async createDraft(account, _d, from) { calls.push({ op: 'draft', account, ...(from ? {} : {}) }) },
    }
    const { provider } = make(undefined, actions)
    const folders = await provider.listFolders()
    const inbox = folders.find((x) => x.kind === 'inbox')!, archive = folders.find((x) => x.kind === 'archive')!
    const m = (await provider.listMessages(inbox.id, { limit: 1 })).items[0]!
    await provider.move([m.id], archive.id)
    await provider.markRead([m.id], true)
    await provider.flag([m.id], true)
    const d = await provider.createDraft({ to: [{ address: 'x@example.com' }], subject: 'hi', textBody: 'text' })
    expect(d.flags.draft).toBe(true)
    expect(calls.map((c) => c.op)).toEqual(['move', 'read', 'flag', 'draft'])
    expect(calls[0]).toMatchObject({ dest: ['Archive'], refs: [{ accountId: FIXTURE_LOCAL_ACCOUNT, mailboxPath: ['Inbox'] }] })
    expect(calls[0]!.refs![0]!.messageIdHeader).toMatch(/^<.+>$/)
    await expect(provider.send(d.id)).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(provider.delete([m.id])).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(provider.move(['a999999'], archive.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('change detection', () => {
  it('reports new mail, a flag change, a move out and a deletion; and asks for a resync after a restart', async () => {
    const { provider, source } = make()
    const start = await provider.listChanges()
    expect(start.changes).toEqual([])
    expect((await provider.listChanges(start.syncToken)).changes).toEqual([])
    const inbox = source.boxByName('Inbox')
    const fresh = source.deliver({ mailbox: inbox, subject: 'fresh', from: 'f@example.com', text: 'hi' })
    source.markRead(2, !(await source.message(2))!.read)
    const moved = [...(await source.messages({ mailboxIds: [inbox], limit: 5 })).items].find((r) => r.rowid !== fresh && r.rowid !== 2)!.rowid
    source.moveTo(moved, source.boxByName('Archive'))
    const gone = (await source.messages({ mailboxIds: [inbox], limit: 50 })).items.find((r) => ![fresh, 2, moved].includes(r.rowid))!.rowid
    source.remove(gone)
    const c = await provider.listChanges(start.syncToken)
    const up = c.changes.filter((x) => x.type === 'upsert').map((x) => x.messageId)
    const del = c.changes.filter((x) => x.type === 'delete').map((x) => x.messageId)
    expect(up).toEqual(expect.arrayContaining([`a${fresh}`, 'a2', `a${moved}`]))
    expect(del).toEqual([`a${gone}`])
    expect((await provider.listChanges(c.syncToken)).changes).toEqual([])
    // A new provider object (an app restart) has no baseline for the old token.
    const again = new LocalMailProvider({ account: provider.account, source, localAccountId: FIXTURE_LOCAL_ACCOUNT })
    expect((await again.listChanges(start.syncToken)).fullResyncNeeded).toBe(true)
  })
  it('drives the shared sync: a full sync, then incremental changes land in the cache', async () => {
    const { provider, source } = make()
    const cache = new InMemoryEmailCache()
    await syncAccount(provider, cache)
    const total = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).total
    expect(total).toBe((await source.messages({ limit: 2000 })).total)
    const inbox = source.boxByName('Inbox')
    const fresh = source.deliver({ mailbox: inbox, subject: 'incoming', from: 'in@example.com', text: 'hello' })
    const r = await syncAccount(provider, cache)
    expect(r.mode).toBe('incremental')
    expect(await cache.getMessage(`a${fresh}`)).toMatchObject({ subject: 'incoming' })
    source.remove(fresh)
    await syncAccount(provider, cache)
    expect(await cache.getMessage(`a${fresh}`)).toBeUndefined()
  })
  it('works with the review window: the window is a dated query and widening backfills', async () => {
    const { provider, source } = make()
    const cache = new InMemoryEmailCache(), s = store()
    const now = new Date('2026-11-02T12:00:00.000Z')
    await syncForWindow(provider, cache, s, 7, { now })
    const narrow = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).total
    await syncForWindow(provider, cache, s, 'all', { now })
    const wide = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).total
    expect(narrow).toBeGreaterThan(0)
    expect(wide).toBeGreaterThan(narrow)
    expect(wide).toBe((await source.messages({ limit: 2000 })).total)
    expect(windowSince(7, now)).toBeDefined()
  })
})

describe('errors from the source', () => {
  it('maps the Rust codes', () => {
    expect(mapLocalSourceError('permission_denied').code).toBe('permission_denied')
    expect(mapLocalSourceError('unsupported_layout: messages.size is missing').code).toBe('unsupported_layout')
    expect(mapLocalSourceError('sql: boom').code).toBe('other')
    expect(mapLocalSourceError(new LocalSourceError('not_found')).code).toBe('not_found')
  })
  it('a failing source surfaces its error, but a missing body does not', async () => {
    const { provider, source } = make()
    const inbox = (await provider.listFolders()).find((x) => x.kind === 'inbox')!
    source.body = async () => { throw new LocalSourceError('permission_denied') }
    await expect(provider.listMessages(inbox.id, { limit: 2 })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(EmailProviderError).toBeDefined()
  })
})
