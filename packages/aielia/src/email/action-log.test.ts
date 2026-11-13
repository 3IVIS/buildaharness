import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import {
  BULK_CEILING_PER_TURN, EmailActionError, EmailActionLog, TurnCeiling, applyChange, previewChange, undoAction, type ActionContext,
} from './action-log.js'
import type { Message } from './model.js'

const ALL = { offset: 0, limit: 100_000 }
async function setup(): Promise<{ ctx: ActionContext; p: FakeEmailProvider; c: InMemoryEmailCache }> {
  const p = new FakeEmailProvider()
  const c = new InMemoryEmailCache()
  await syncAccount(p, c)
  return { ctx: { cache: c, provider: p, log: new EmailActionLog(), now: () => '2026-11-13T00:00:00.000Z' }, p, c }
}
async function snapshot(p: FakeEmailProvider): Promise<Message[]> {
  const out: Message[] = []
  for (const f of await p.listFolders()) {
    let token: string | undefined
    do {
      const pg = await p.listMessages(f.id, { limit: 50, ...(token ? { pageToken: token } : {}) })
      out.push(...pg.items)
      token = pg.nextPageToken
    } while (token)
  }
  return [...new Map(out.map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id))
}
async function inboxIds(c: InMemoryEmailCache, n: number): Promise<string[]> {
  return (await c.queryMessages({ folderId: 'fld-inbox' }, ALL)).items.slice(0, n).map((m) => m.id)
}

describe('action log', () => {
  it('single action runs without confirmation and undo restores exactly', async () => {
    const { ctx, p } = await setup()
    const [id] = await inboxIds(ctx.cache as InMemoryEmailCache, 1)
    const before = await snapshot(p)
    const a = await applyChange(ctx, { type: 'flag', starred: true }, [id!])
    expect(a?.entries).toHaveLength(1)
    expect((await p.getMessage(id!)).flags.starred).toBe(true)
    expect((await ctx.cache.getMessage(id!))?.flags.starred).toBe(true)
    const r = await undoAction(ctx, a!.id)
    expect(r.restored).toEqual([id])
    expect(await snapshot(p)).toEqual(before)
    expect(await ctx.cache.getMessage(id!)).toEqual(before.find((m) => m.id === id))
  })

  it('bulk move needs confirmation, previews exactly what it touches, and undo restores exactly', async () => {
    const { ctx, p, c } = await setup()
    const ids = await inboxIds(c, 5)
    const folders = await p.listFolders()
    const target = folders.find((f) => f.id !== 'fld-inbox')!.id
    const before = await snapshot(p)
    const prev = await previewChange(ctx, { type: 'move', folderId: target }, ids)
    expect(prev.rows.map((r) => r.messageId).sort()).toEqual([...ids].sort())
    expect(prev.needsConfirmation).toBe(true)
    await expect(applyChange(ctx, { type: 'move', folderId: target }, ids)).rejects.toMatchObject({ code: 'needs_confirmation' })
    expect(await snapshot(p)).toEqual(before)
    const a = await applyChange(ctx, { type: 'move', folderId: target }, ids, { confirmed: true })
    for (const id of ids) expect((await p.getMessage(id)).folderIds).toEqual([target])
    const r = await undoAction(ctx, a!.id)
    expect(r.restored.sort()).toEqual([...ids].sort())
    expect(r.conflicts).toEqual([])
    expect(await snapshot(p)).toEqual(before)
  })

  it('restores multi-folder membership and read flags', async () => {
    const { ctx, p, c } = await setup()
    const [id] = await inboxIds(c, 1)
    const target = (await p.listFolders()).find((f) => f.id !== 'fld-inbox')!.id
    await p.label([id!], target, true)
    await syncAccount(p, c)
    const before = await snapshot(p)
    const a1 = await applyChange(ctx, { type: 'move', folderId: target }, [id!])
    const a2 = await applyChange(ctx, { type: 'read', read: !before.find((m) => m.id === id)!.flags.read }, [id!])
    await undoAction(ctx, a2!.id)
    await undoAction(ctx, a1!.id)
    expect(await snapshot(p)).toEqual(before)
  })

  it('a change that alters nothing is not logged', async () => {
    const { ctx, c } = await setup()
    const [m] = (await c.queryMessages({ folderId: 'fld-inbox' }, ALL)).items
    const res = await applyChange(ctx, { type: 'read', read: m!.flags.read }, [m!.id])
    expect(res).toBeUndefined()
    expect(ctx.log.list()).toHaveLength(0)
  })

  it('enforces the ceiling, even when confirmed', async () => {
    const { ctx, p, c } = await setup()
    const all = (await c.queryMessages({}, ALL)).items.map((m) => m.id)
    const many = Array.from({ length: BULK_CEILING_PER_TURN + 1 }, (_, i) => all[i % all.length]!)
    const tiny = { ...ctx, turn: new TurnCeiling(2) }
    const ids = await inboxIds(c, 3)
    const before = await snapshot(p)
    await expect(applyChange(tiny, { type: 'flag', starred: true }, ids, { confirmed: true })).rejects.toBeInstanceOf(EmailActionError)
    expect(await snapshot(p)).toEqual(before)
    expect(many.length).toBeGreaterThan(BULK_CEILING_PER_TURN)
    const t = new TurnCeiling()
    expect(t.take(BULK_CEILING_PER_TURN)).toBe(true)
    expect(t.take(1)).toBe(false)
  })

  it('the ceiling counts across calls in one turn', async () => {
    const { ctx, c } = await setup()
    const turn = new TurnCeiling(3)
    const ids = await inboxIds(c, 4)
    await applyChange({ ...ctx, turn }, { type: 'flag', starred: true }, ids.slice(0, 2), { confirmed: true })
    await expect(applyChange({ ...ctx, turn }, { type: 'flag', starred: true }, ids.slice(2, 4), { confirmed: true })).rejects.toMatchObject({ code: 'ceiling' })
  })

  it('undo reports a message that moved since, instead of guessing', async () => {
    const { ctx, p, c } = await setup()
    const [a, b] = await inboxIds(c, 2)
    const target = (await p.listFolders()).find((f) => f.id !== 'fld-inbox')!.id
    const other = (await p.listFolders()).find((f) => f.id !== 'fld-inbox' && f.id !== target)!.id
    const act = await applyChange(ctx, { type: 'move', folderId: target }, [a!, b!], { confirmed: true })
    await p.move([b!], other)
    const r = await undoAction(ctx, act!.id)
    expect(r.restored).toEqual([a])
    expect(r.conflicts).toEqual([{ messageId: b, reason: 'changed_since' }])
    expect((await p.getMessage(b!)).folderIds).toEqual([other])
    expect((await p.getMessage(a!)).folderIds).toEqual(['fld-inbox'])
  })

  it('undo reports a message that no longer exists, and a second undo is refused', async () => {
    const { ctx, p, c } = await setup()
    const [a] = await inboxIds(c, 1)
    const act = await applyChange(ctx, { type: 'flag', starred: true }, [a!])
    const trash = (await p.listFolders()).find((f) => f.id.includes('trash'))
    if (trash) await p.delete([a!]).then(() => p.delete([a!]))
    const r = await undoAction(ctx, act!.id)
    expect(r.conflicts[0]?.reason).toBe(trash ? 'not_found' : 'changed_since')
    const act2 = await applyChange(ctx, { type: 'flag', starred: true }, [(await inboxIds(c, 2))[1]!])
    await undoAction(ctx, act2!.id)
    await expect(undoAction(ctx, act2!.id)).rejects.toMatchObject({ code: 'already_undone' })
  })
})
