import { describe, it, expect } from 'vitest'
import { FakeEmailProvider } from './fake-provider.js'
import { generateSyntheticMailbox, SYNTHETIC_CATEGORIES } from './synthetic-mailbox.js'
import { EmailProviderError } from './provider.js'
import { parseMessage, parseThread, parseFolder, parseAccount } from './model.js'

describe('synthetic mailbox', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    expect(generateSyntheticMailbox({ seed: 7 })).toEqual(generateSyntheticMailbox({ seed: 7 }))
    expect(generateSyntheticMailbox({ seed: 7 })).not.toEqual(generateSyntheticMailbox({ seed: 8 }))
  })
  it('produces each category at least once and valid records', () => {
    const mb = generateSyntheticMailbox({ seed: 3, perCategory: 1 })
    const seen = new Set(Object.values(mb.categoryByThread))
    for (const c of SYNTHETIC_CATEGORIES) expect(seen.has(c)).toBe(true)
    expect(parseAccount(mb.account).ok).toBe(true)
    for (const f of mb.folders) expect(parseFolder(f).ok).toBe(true)
    for (const t of mb.threads) expect(parseThread(t).ok).toBe(true)
    for (const m of mb.messages) expect(parseMessage(m).ok).toBe(true)
  })
  it('uses only reserved example domains', () => {
    const mb = generateSyntheticMailbox({ seed: 5 })
    for (const m of mb.messages) for (const a of [m.from, ...m.to]) expect(a.address).toMatch(/(@|\.)example\.(com|org|net)$/)
  })
})

const fresh = () => new FakeEmailProvider(generateSyntheticMailbox({ seed: 2 }))

describe('FakeEmailProvider', () => {
  it('lists folders with unread counts', async () => {
    const f = await fresh().listFolders()
    expect(f.map((x) => x.kind)).toEqual(expect.arrayContaining(['inbox', 'sent', 'drafts', 'archive', 'trash', 'custom']))
    expect(f.find((x) => x.kind === 'inbox')!.unreadCount).toBeGreaterThan(0)
  })
  it('pages messages and threads', async () => {
    const p = fresh()
    const all: string[] = []
    let token: string | undefined
    do {
      const pg = await p.listMessages('fld-inbox', { limit: 4, pageToken: token })
      all.push(...pg.items.map((m) => m.id))
      token = pg.nextPageToken
    } while (token)
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeGreaterThan(4)
    const th = await p.listThreads('fld-inbox', { limit: 3 })
    expect(th.items.length).toBe(3)
    expect(th.nextPageToken).toBeDefined()
  })
  it('fetches a message and a thread; unknown ids are not_found', async () => {
    const p = fresh()
    const first = (await p.listMessages('fld-inbox')).items[0]
    expect((await p.getMessage(first.id)).id).toBe(first.id)
    const { thread, messages } = await p.getThread(first.threadId)
    expect(messages.length).toBe(thread.messageIds.length)
    await expect(p.getMessage('nope')).rejects.toBeInstanceOf(EmailProviderError)
    await expect(p.getThread('nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(p.listMessages('nope')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('does not leak internal state through returned copies', async () => {
    const p = fresh()
    const m = (await p.listMessages('fld-inbox')).items[0]
    m.subject = 'changed'
    expect((await p.getMessage(m.id)).subject).not.toBe('changed')
  })
  it('searches by text, sender, unread and folder', async () => {
    const p = fresh()
    const byText = await p.search({ text: 'report due' })
    expect(byText.items.length).toBeGreaterThan(0)
    expect(byText.items.every((m) => m.subject.toLowerCase().includes('report due'))).toBe(true)
    expect((await p.search({ from: 'news@' })).items.length).toBeGreaterThan(0)
    expect((await p.search({ unreadOnly: true, folderId: 'fld-sent' })).items.length).toBe(0)
    expect((await p.search({ text: 'zzz-no-such-text' })).items.length).toBe(0)
  })
  it('moves, labels, flags and marks read', async () => {
    const p = fresh()
    const id = (await p.listMessages('fld-inbox')).items[0].id
    await p.move([id], 'fld-archive')
    expect((await p.getMessage(id)).folderIds).toEqual(['fld-archive'])
    await p.label([id], 'fld-projects', true)
    expect((await p.getMessage(id)).folderIds).toEqual(['fld-archive', 'fld-projects'])
    await p.label([id], 'fld-projects', false)
    expect((await p.getMessage(id)).folderIds).toEqual(['fld-archive'])
    await p.flag([id], true)
    await p.markRead([id], true)
    const m = await p.getMessage(id)
    expect(m.flags.starred).toBe(true)
    expect(m.flags.read).toBe(true)
    await expect(p.move([id], 'nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(p.flag(['nope'], true)).rejects.toMatchObject({ code: 'not_found' })
  })
  it('keeps the thread in step with its messages', async () => {
    const p = fresh()
    const m = (await p.listMessages('fld-inbox')).items.find((x) => !x.flags.read)!
    await p.markRead([m.id], true)
    const { thread } = await p.getThread(m.threadId)
    expect(thread.unread).toBe(false)
  })
  it('creates a draft and sends it', async () => {
    const p = fresh()
    const d = await p.createDraft({ to: [{ address: 'x@example.com' }], subject: 'Hi', textBody: 'Hello' })
    expect(d.flags.draft).toBe(true)
    expect((await p.listMessages('fld-drafts')).items.map((x) => x.id)).toContain(d.id)
    const sent = await p.send(d.id)
    expect(sent.flags.draft).toBe(false)
    expect(sent.folderIds).toEqual(['fld-sent'])
    await expect(p.send(d.id)).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(p.createDraft({ to: [], subject: '', textBody: '' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(p.createDraft({ threadId: 'nope', to: [{ address: 'x@example.com' }], subject: '', textBody: '' })).rejects.toMatchObject({ code: 'not_found' })
  })
  it('delete moves to trash, then removes for good', async () => {
    const p = fresh()
    const id = (await p.listMessages('fld-inbox')).items[0].id
    await p.delete([id])
    expect((await p.getMessage(id)).folderIds).toEqual(['fld-trash'])
    await p.delete([id])
    await expect(p.getMessage(id)).rejects.toMatchObject({ code: 'not_found' })
  })
  it('reports incremental changes from a sync token', async () => {
    const p = fresh()
    const start = await p.listChanges()
    expect(start.changes).toEqual([])
    const none = await p.listChanges(start.syncToken)
    expect(none.changes).toEqual([])
    const id = (await p.listMessages('fld-inbox')).items[0].id
    await p.markRead([id], true)
    await p.flag([id], true)
    const arrived = p.deliver({ from: { address: 'z@example.com' }, subject: 'New', textBody: 'x' })
    await p.delete([id])
    await p.delete([id])
    const c = await p.listChanges(start.syncToken)
    expect(c.fullResyncNeeded).toBe(false)
    expect(c.changes).toContainEqual({ type: 'upsert', messageId: arrived.id })
    expect(c.changes).toContainEqual({ type: 'delete', messageId: id })
    expect(c.changes.filter((x) => x.messageId === id).length).toBe(1)
    expect((await p.listChanges(c.syncToken)).changes).toEqual([])
  })
  it('asks for a full resync when the token is unknown or expired', async () => {
    const p = fresh()
    const t = (await p.listChanges()).syncToken
    await p.markRead([(await p.listMessages('fld-inbox')).items[0].id], true)
    p.expireHistory()
    expect((await p.listChanges(t)).fullResyncNeeded).toBe(true)
    expect((await p.listChanges('garbage')).fullResyncNeeded).toBe(true)
    const fresh2 = await p.listChanges((await p.listChanges()).syncToken)
    expect(fresh2.fullResyncNeeded).toBe(false)
  })
})
