import { describe, it, expect } from 'vitest'
import { FakeEmailProvider } from './fake-provider.js'
import { EmailSendError, SendCoordinator, createProviderSender, fingerprintMessage, parseAddressList, type StagedMessage } from './send.js'

async function sentCount(p: FakeEmailProvider): Promise<number> {
  return (await p.listMessages('fld-sent', { limit: 1000 })).items.length
}
async function threadWithParticipants(p: FakeEmailProvider): Promise<{ threadId: string; known: string }> {
  const m = (await p.listMessages('fld-inbox', { limit: 1 })).items[0]!
  return { threadId: m.threadId, known: m.from.address }
}
const msg = (over: Partial<StagedMessage> = {}): StagedMessage => ({
  to: [{ address: 'new.person@example.org' }], cc: [], bcc: [], subject: 'Hello', textBody: 'Body text', ...over,
})

describe('staged send', () => {
  it('sends nothing before approval', async () => {
    const p = new FakeEmailProvider()
    const before = await sentCount(p)
    const c = new SendCoordinator(p)
    const staged = await c.stage(msg())
    expect(await sentCount(p)).toBe(before)
    expect(c.status(staged.id)).toBe('staged')
    expect(staged.approvalText).toContain('new.person@example.org')
  })

  it('the approved message equals the staged one', async () => {
    const p = new FakeEmailProvider()
    const c = new SendCoordinator(p)
    const staged = await c.stage(msg({ cc: [{ address: 'cc@example.org' }] }))
    const r = await c.approve(staged.id, staged.fingerprint)
    expect(r.status).toBe('sent')
    const sent = await p.getMessage(r.messageId)
    expect(sent.to.map((a) => a.address)).toEqual(['new.person@example.org'])
    expect(sent.cc.map((a) => a.address)).toEqual(['cc@example.org'])
    expect(sent.subject).toBe('Hello')
    expect(sent.textBody).toBe('Body text')
    expect(sent.folderIds).toEqual(['fld-sent'])
  })

  it('a changed recipient after staging needs a new approval', async () => {
    const p = new FakeEmailProvider()
    const before = await sentCount(p)
    const c = new SendCoordinator(p)
    const staged = await c.stage(msg())
    const changed = await c.restage(staged.id, msg({ bcc: [{ address: 'silent@example.org' }] }))
    expect(changed.fingerprint).not.toBe(staged.fingerprint)
    await expect(c.approve(staged.id, staged.fingerprint)).rejects.toMatchObject({ code: 'needs_reapproval' })
    expect(await sentCount(p)).toBe(before)
    expect(changed.approvalText).toContain('Bcc: silent@example.org')
    await expect(c.approve(staged.id, changed.fingerprint)).resolves.toMatchObject({ status: 'sent' })
  })

  it('warns about a recipient not on the thread, and only that one', async () => {
    const p = new FakeEmailProvider()
    const { threadId, known } = await threadWithParticipants(p)
    const c = new SendCoordinator(p)
    const staged = await c.stage(msg({ threadId, to: [{ address: known }], cc: [{ address: 'Outsider@Example.org' }] }))
    expect(staged.warnings).toEqual(['Outsider@Example.org was not on this thread'])
    expect(staged.approvalText).toContain('WARNING: Outsider@Example.org was not on this thread')
    const clean = await c.stage(msg({ threadId, to: [{ address: known.toUpperCase() }] }))
    expect(clean.warnings).toEqual([])
  })

  it('a message with no recipient cannot be staged', async () => {
    const c = new SendCoordinator(new FakeEmailProvider())
    await expect(c.stage(msg({ to: [] }))).rejects.toBeInstanceOf(EmailSendError)
  })

  it('an approval cannot be used twice', async () => {
    const c = new SendCoordinator(new FakeEmailProvider())
    const s = await c.stage(msg())
    await c.approve(s.id, s.fingerprint)
    await expect(c.approve(s.id, s.fingerprint)).rejects.toMatchObject({ code: 'not_pending' })
  })

  it('holds for the delay, undo cancels, release sends', async () => {
    const p = new FakeEmailProvider()
    const before = await sentCount(p)
    let t = 1000
    const c = new SendCoordinator(p, { delaySeconds: 10, now: () => t })
    const a = await c.stage(msg())
    const held = await c.approve(a.id, a.fingerprint)
    expect(held.status).toBe('held')
    expect(await sentCount(p)).toBe(before)
    t += 5000
    expect(await c.releaseDue()).toEqual([])
    await c.undo(a.id)
    expect(c.status(a.id)).toBe('undone')
    t += 20000
    expect(await c.releaseDue()).toEqual([])
    expect(await sentCount(p)).toBe(before)
    expect((await p.getMessage(held.messageId)).folderIds).toEqual(['fld-trash'])

    const b = await c.stage(msg({ subject: 'Second' }))
    await c.approve(b.id, b.fingerprint)
    t += 11000
    expect(await c.releaseDue()).toEqual([b.id])
    expect(await sentCount(p)).toBe(before + 1)
    await expect(c.undo(b.id)).rejects.toMatchObject({ code: 'not_pending' })
  })

  it('fingerprint ignores address case and order but not content', () => {
    const a = msg({ to: [{ address: 'A@x.org' }, { address: 'b@x.org' }] })
    const b = msg({ to: [{ address: 'b@x.org' }, { address: 'a@x.org' }] })
    expect(fingerprintMessage(a)).toBe(fingerprintMessage(b))
    expect(fingerprintMessage(a)).not.toBe(fingerprintMessage({ ...a, textBody: 'other' }))
  })

  it('parses address lists and refuses malformed ones', () => {
    expect(parseAddressList('a@x.org, b@y.com')).toEqual([{ address: 'a@x.org' }, { address: 'b@y.com' }])
    expect(parseAddressList(undefined)).toEqual([])
    for (const bad of ['nope', 'a@b', 'a@@x.org', '@x.org', 'a b@x.org']) expect(() => parseAddressList(bad)).toThrow(EmailSendError)
  })

  it('the SendEmail adapter delivers through the provider', async () => {
    const p = new FakeEmailProvider()
    const before = await sentCount(p)
    const r = await createProviderSender(p)({ to: 'x@example.org', subject: 'S', body: 'B', cc: 'c@example.org' })
    expect(r.provider).toBe('account')
    expect(await sentCount(p)).toBe(before + 1)
    await expect(createProviderSender(p)({ to: 'bad', subject: 'S', body: 'B' })).rejects.toBeInstanceOf(EmailSendError)
  })
})
