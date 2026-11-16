import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import type { Message } from './model.js'

const ALL = { offset: 0, limit: 100_000 }

async function allMessages(c: InMemoryEmailCache): Promise<Message[]> {
  return (await c.queryMessages({}, ALL)).items
}
/** The cache must hold exactly what the provider holds. */
async function expectMirror(p: FakeEmailProvider, c: InMemoryEmailCache): Promise<void> {
  const cached = (await allMessages(c)).sort((a, b) => a.id.localeCompare(b.id))
  const truth: Message[] = []
  for (const f of await p.listFolders()) {
    let token: string | undefined
    do {
      const pg = await p.listMessages(f.id, { limit: 20, ...(token ? { pageToken: token } : {}) })
      truth.push(...pg.items)
      token = pg.nextPageToken
    } while (token)
  }
  const uniq = [...new Map(truth.map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id))
  expect(cached).toEqual(uniq)
}

describe('syncAccount', () => {
  it('initial sync lists everything in pages and stores a change token', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    const r = await syncAccount(p, c, { pageSize: 7 })
    expect(r).toMatchObject({ mode: 'initial', status: 'complete' })
    expect(r.pages).toBeGreaterThan(2)
    await expectMirror(p, c)
    expect((await c.getFolders(p.account.id)).length).toBeGreaterThan(0)
    expect((await c.listThreads(undefined, ALL)).total).toBeGreaterThan(0)
    expect(await c.getSyncToken(p.account.id)).toMatch(/^v\d+$/)
  })

  it('incremental sync picks up a new message and its thread', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    await syncAccount(p, c)
    const m = p.deliver({ from: { address: 'x@example.com' }, subject: 'hello', textBody: 'hi' })
    const r = await syncAccount(p, c)
    expect(r.mode).toBe('incremental')
    expect(r.messagesUpserted).toBe(1)
    expect(await c.getMessage(m.id)).toBeDefined()
    expect(await c.getThread(m.threadId)).toBeDefined()
    await expectMirror(p, c)
  })

  it('a no-change sync does nothing', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    await syncAccount(p, c)
    const r = await syncAccount(p, c)
    expect(r).toMatchObject({ mode: 'incremental', messagesUpserted: 0, messagesDeleted: 0 })
  })

  it('a move updates the cached folder membership', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    await syncAccount(p, c)
    const inbox = await c.queryMessages({ folderId: 'fld-inbox' }, { offset: 0, limit: 1 })
    const target = inbox.items[0]!
    await p.move([target.id], 'fld-archive').catch(async () => p.move([target.id], 'fld-trash'))
    await syncAccount(p, c)
    const after = (await c.getMessage(target.id))!
    expect(after.folderIds).not.toContain('fld-inbox')
    expect((await c.queryMessages({ folderId: 'fld-inbox' }, ALL)).total).toBe(inbox.total - 1)
    await expectMirror(p, c)
  })

  it('a delete (trash, then permanent) removes the message and an emptied thread', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    const m = p.deliver({ from: { address: 'x@example.com' }, subject: 's', textBody: 'b' })
    await syncAccount(p, c)
    await p.delete([m.id])
    await syncAccount(p, c)
    expect((await c.getMessage(m.id))!.folderIds).toEqual(['fld-trash'])
    await p.delete([m.id])
    const r = await syncAccount(p, c)
    expect(r.messagesDeleted).toBe(1)
    expect(await c.getMessage(m.id)).toBeUndefined()
    expect(await c.getThread(m.threadId)).toBeUndefined()
    await expectMirror(p, c)
  })

  it('a message changed then deleted between syncs ends up gone', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    await syncAccount(p, c)
    const m = p.deliver({ from: { address: 'x@example.com' }, subject: 's', textBody: 'b' })
    await p.delete([m.id])
    await p.delete([m.id])
    await syncAccount(p, c)
    expect(await c.getMessage(m.id)).toBeUndefined()
    await expectMirror(p, c)
  })

  it('an interrupted initial sync resumes and ends identical to an uninterrupted one', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    let budget = 3
    const first = await syncAccount(p, c, { pageSize: 5, shouldStop: () => budget-- <= 0 })
    expect(first.status).toBe('interrupted')
    expect(await c.getSyncToken(p.account.id)).toMatch(/^partial:/)
    // Something arrives while the sync is parked.
    p.deliver({ from: { address: 'late@example.com' }, subject: 'late', textBody: 'late' })
    const second = await syncAccount(p, c, { pageSize: 5 })
    expect(second).toMatchObject({ mode: 'initial', status: 'complete' })
    // Resuming did not start over: fewer pages than a full listing.
    const fresh = await syncAccount(p, new InMemoryEmailCache(), { pageSize: 5 })
    expect(second.pages).toBeLessThan(fresh.pages)
    expect(await c.getSyncToken(p.account.id)).toMatch(/^v\d+$/)
    await expectMirror(p, c)
  })

  it('stopping repeatedly after one page each time still converges', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    let r = await syncAccount(p, c, { pageSize: 9, shouldStop: ((n) => () => n++ >= 1)(0) })
    let guard = 0
    while (r.status === 'interrupted' && guard++ < 500) r = await syncAccount(p, c, { pageSize: 9, shouldStop: ((n) => () => n++ >= 1)(0) })
    expect(r.status).toBe('complete')
    await expectMirror(p, c)
  })

  it('a provider that reports full-resync-needed makes the cache rebuild from scratch', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    await syncAccount(p, c)
    // Plant a stale record that the provider does not have; a full resync must drop it.
    const stale = { ...(await allMessages(c))[0]!, id: 'ghost', threadId: 'ghost-thread' }
    await c.upsertMessages([stale])
    p.deliver({ from: { address: 'x@example.com' }, subject: 's', textBody: 'b' })
    p.expireHistory()
    const r = await syncAccount(p, c)
    expect(r).toMatchObject({ mode: 'full_resync', status: 'complete' })
    expect(await c.getMessage('ghost')).toBeUndefined()
    await expectMirror(p, c)
  })

  it('an unreadable partial marker is discarded and the sync starts over', async () => {
    const p = new FakeEmailProvider()
    const c = new InMemoryEmailCache()
    await c.setSyncToken(p.account.id, 'partial:{not json')
    const r = await syncAccount(p, c)
    expect(r.status).toBe('complete')
    await expectMirror(p, c)
  })
})
