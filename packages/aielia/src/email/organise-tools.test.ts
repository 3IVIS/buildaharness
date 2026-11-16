import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import { EmailActionLog, TurnCeiling, type ActionContext } from './action-log.js'
import {
  MAIL_ORGANISE_TOOLS, MAIL_ORGANISE_TOOL_NAMES, OrganiseSession, SnoozeStore, confirmPending, rejectPending, runEmailUndo, runMailOrganiseTool, wakeDueSnoozes,
  type OrganiseDeps,
} from './organise-tools.js'
import { MAIL_TOOL_CLASSES } from '../tool-policy.js'
import type { Message } from './model.js'

const ALL = { offset: 0, limit: 100_000 }
async function setup(over: Partial<OrganiseDeps> = {}): Promise<{ d: OrganiseDeps; p: FakeEmailProvider; c: InMemoryEmailCache }> {
  const p = new FakeEmailProvider()
  const c = new InMemoryEmailCache()
  await syncAccount(p, c)
  const action: ActionContext = { cache: c, provider: p, log: new EmailActionLog(), now: () => '2026-11-13T00:00:00.000Z', turn: new TurnCeiling() }
  return { d: { account: p.account, action, session: new OrganiseSession(), snoozes: new SnoozeStore(), ...over }, p, c }
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
const inbox = async (c: InMemoryEmailCache, n: number): Promise<string[]> => (await c.queryMessages({ folderId: 'fld-inbox' }, ALL)).items.slice(0, n).map((m) => m.id)

describe('tool set', () => {
  it('every organising tool is declared reversible and has a definition', () => {
    expect(MAIL_ORGANISE_TOOLS.map((t) => t.name)).toEqual([...MAIL_ORGANISE_TOOL_NAMES])
    for (const n of MAIL_ORGANISE_TOOL_NAMES) expect(MAIL_TOOL_CLASSES[n]).toBe('reversible')
    for (const t of MAIL_ORGANISE_TOOLS) expect(JSON.stringify(t.input_schema)).not.toContain('confirm')
  })
})

describe('one message', () => {
  it('runs at once, reports an action id, and undo restores exactly', async () => {
    const { d, p, c } = await setup()
    const [id] = await inbox(c, 1)
    const before = await snapshot(p)
    const r = await runMailOrganiseTool('mail_flag', { messageIds: [id] }, d)
    expect(r.status).toBe('applied')
    expect(r.actionId).toBeTruthy()
    expect((await p.getMessage(id!)).flags.starred).toBe(true)
    const u = await runEmailUndo(d)
    expect(u.result?.restored).toEqual([id])
    expect(await snapshot(p)).toEqual(before)
  })
  it('model-facing text carries no subject', async () => {
    const { d, c } = await setup()
    const ids = await inbox(c, 3)
    const subject = (await c.getMessage(ids[0]!))!.subject
    const r = await runMailOrganiseTool('mail_mark_read', { messageIds: ids, read: true }, d)
    expect(r.text).not.toContain(subject)
  })
})

describe('bulk and bypass attempts', () => {
  it('many messages preview first and change nothing; a confirmed argument is ignored', async () => {
    const { d, p, c } = await setup()
    const ids = await inbox(c, 5)
    const before = await snapshot(p)
    const r = await runMailOrganiseTool('mail_flag', { messageIds: ids, confirmed: true, confirm: true, approved: true }, d)
    expect(r.status).toBe('preview')
    expect(r.pending?.preview.rows).toHaveLength(5)
    expect(await snapshot(p)).toEqual(before)
    expect(d.action.log.list()).toHaveLength(0)
  })
  it('only confirmPending runs it, then undo restores exactly', async () => {
    const { d, p, c } = await setup()
    const ids = await inbox(c, 4)
    const before = await snapshot(p)
    const r = await runMailOrganiseTool('mail_flag', { messageIds: ids }, d)
    const done = await confirmPending(d, r.pending!.id)
    expect(done.status).toBe('applied')
    for (const id of ids) expect((await p.getMessage(id)).flags.starred).toBe(true)
    await runEmailUndo(d, done.actionId)
    expect(await snapshot(p)).toEqual(before)
    expect((await confirmPending(d, r.pending!.id)).status).toBe('error')
  })
  it('a rejected preview never runs', async () => {
    const { d, p, c } = await setup()
    const before = await snapshot(p)
    const r = await runMailOrganiseTool('mail_flag', { messageIds: await inbox(c, 3) }, d)
    expect(rejectPending(d.session, r.pending!.id)).toBe(true)
    expect((await confirmPending(d, r.pending!.id)).status).toBe('error')
    expect(await snapshot(p)).toEqual(before)
  })
  it('splitting a bulk change into single calls previews from the second one', async () => {
    const { d, p, c } = await setup()
    const ids = await inbox(c, 3)
    expect((await runMailOrganiseTool('mail_flag', { messageIds: [ids[0]] }, d)).status).toBe('applied')
    const second = await runMailOrganiseTool('mail_flag', { messageIds: [ids[1]] }, d)
    expect(second.status).toBe('preview')
    expect(second.pending?.reason).toBe('second_change_in_turn')
    expect((await p.getMessage(ids[1]!)).flags.starred).toBe(false)
    d.session.newTurn()
    expect((await runMailOrganiseTool('mail_flag', { messageIds: [ids[2]] }, d)).status).toBe('applied')
  })
  it('the ceiling holds even through confirmation', async () => {
    const { d, p, c } = await setup()
    const ids = await inbox(c, 6)
    d.action.turn = new TurnCeiling(3)
    const before = await snapshot(p)
    const r = await runMailOrganiseTool('mail_flag', { messageIds: ids }, d)
    expect(r.status).toBe('error')
    expect(await snapshot(p)).toEqual(before)
    const ok = await runMailOrganiseTool('mail_flag', { messageIds: ids.slice(0, 3) }, d)
    const done = await confirmPending(d, ok.pending!.id)
    expect(done.status).toBe('applied')
    d.action.turn = new TurnCeiling(3)
    d.action.turn.take(3)
    const more = await runMailOrganiseTool('mail_mark_read', { messageIds: ids.slice(0, 3) }, d)
    expect(more.status).toBe('error')
  })
})

describe('policy', () => {
  it('after reading mail text a single change is staged with its origin, not run (negative control: user origin runs)', async () => {
    const { d, p, c } = await setup({ origin: 'untrusted_mail' })
    const [id] = await inbox(c, 1)
    const r = await runMailOrganiseTool('mail_flag', { messageIds: [id] }, d)
    expect(r.status).toBe('staged')
    expect(r.gate.decision).toBe('REQUIRE_APPROVAL')
    expect((await p.getMessage(id!)).flags.starred).toBe(false)
    const ctl = await setup({ origin: 'user' })
    expect((await runMailOrganiseTool('mail_flag', { messageIds: [(await inbox(ctl.c, 1))[0]] }, ctl.d)).status).toBe('applied')
    expect((await confirmPending(d, r.pending!.id)).status).toBe('applied')
  })
  it('a DENY control state runs nothing', async () => {
    const { d, p, c } = await setup({ controlState: { permission: 'DENY', execution_mode: 'RECOVERY', escalation: 'NONE' } })
    const before = await snapshot(p)
    expect((await runMailOrganiseTool('mail_flag', { messageIds: await inbox(c, 1) }, d)).status).toBe('denied')
    expect(await snapshot(p)).toEqual(before)
  })
  it('refuses outward tools, trash as a target, and unknown ids', async () => {
    const { d, c } = await setup()
    const [id] = await inbox(c, 1)
    expect((await runMailOrganiseTool('mail_send', { messageIds: [id] }, d)).status).toBe('error')
    expect((await runMailOrganiseTool('mail_delete_permanent', { messageIds: [id] }, d)).status).toBe('error')
    const trash = (await c.getFolders(d.account.id)).find((f) => f.kind === 'trash')
    if (trash) expect((await runMailOrganiseTool('mail_move', { messageIds: [id], folder: trash.id }, d)).status).toBe('error')
    expect((await runMailOrganiseTool('mail_flag', { messageIds: ['nope'] }, d)).text).toContain('not found')
  })
})

describe('archive, move, snooze', () => {
  it('archive moves to the archive folder and undo restores', async () => {
    const { d, p, c } = await setup()
    const [id] = await inbox(c, 1)
    const before = await snapshot(p)
    const arch = (await c.getFolders(d.account.id)).find((f) => f.kind === 'archive')!
    expect((await runMailOrganiseTool('mail_archive', { messageIds: [id] }, d)).status).toBe('applied')
    expect((await p.getMessage(id!)).folderIds).toEqual([arch.id])
    await runEmailUndo(d)
    expect(await snapshot(p)).toEqual(before)
  })
  it('snooze hides the message, then wakes it back into its folder when due', async () => {
    const { d, p, c } = await setup()
    const [id] = await inbox(c, 1)
    expect((await runMailOrganiseTool('mail_snooze', { messageIds: [id], until: '2026-11-14T08:00:00.000Z' }, d)).status).toBe('applied')
    expect((await p.getMessage(id!)).folderIds).not.toContain('fld-inbox')
    expect(await wakeDueSnoozes(d)).toHaveLength(0)
    d.action.now = () => '2026-11-14T09:00:00.000Z'
    expect(await wakeDueSnoozes(d)).toHaveLength(1)
    expect((await p.getMessage(id!)).folderIds).toEqual(['fld-inbox'])
    expect(d.snoozes.list()).toHaveLength(0)
  })
  it('snooze rejects a past or malformed time', async () => {
    const { d, c } = await setup()
    const [id] = await inbox(c, 1)
    expect((await runMailOrganiseTool('mail_snooze', { messageIds: [id], until: '2020-01-01T00:00:00Z' }, d)).status).toBe('error')
    expect((await runMailOrganiseTool('mail_snooze', { messageIds: [id], until: 'soon' }, d)).status).toBe('error')
  })
  it('undo with nothing logged says so', async () => {
    const { d } = await setup()
    expect((await runEmailUndo(d)).lines).toEqual(['Nothing to undo.'])
  })
})
