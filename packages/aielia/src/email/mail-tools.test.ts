import { describe, it, expect } from 'vitest'
import { createScriptedLLMClient } from '../scripted-llm-client.js'
import { generateSyntheticMailbox } from './synthetic-mailbox.js'
import { InMemoryEmailCache } from './cache.js'
import { addChip, chipLabel, removeChip, resolveContext, EMPTY_MAIL_CONTEXT, type MailContext } from './mail-context.js'
import { MAIL_READ_TOOLS, MAIL_READ_TOOL_NAMES, runMailReadTool, type MailToolDeps } from './mail-tools.js'
import { MAIL_TOOL_CLASSES } from '../tool-policy.js'
import type { TodoItem } from './model.js'

const mb = generateSyntheticMailbox({ seed: 5, perCategory: 1 })
async function setup(over: Partial<MailToolDeps['account']> = {}, context: MailContext = EMPTY_MAIL_CONTEXT, extra: Partial<MailToolDeps> = {}): Promise<MailToolDeps> {
  const cache = new InMemoryEmailCache()
  await cache.upsertFolders(mb.folders)
  await cache.upsertThreads(mb.threads)
  await cache.upsertMessages(mb.messages)
  return { account: { ...mb.account, aieliaMayRead: true, excludedFolders: [], excludedSenders: [], ...over }, cache, context, ...extra }
}
const inboxMsg = mb.messages.find((m) => m.folderIds.includes('fld-inbox'))!
const sentMsg = mb.messages.find((m) => m.folderIds.includes('fld-sent'))!

describe('tool set', () => {
  it('every read tool is declared read_only in the policy and has a definition', () => {
    expect(MAIL_READ_TOOLS.map((t) => t.name)).toEqual([...MAIL_READ_TOOL_NAMES])
    for (const n of MAIL_READ_TOOL_NAMES) expect(MAIL_TOOL_CLASSES[n]).toBe('read_only')
  })
})

describe('read-only gate', () => {
  it('runs immediately on ALLOW and wraps mail as untrusted', async () => {
    const r = await runMailReadTool('mail_search', {}, await setup())
    expect(r.ok).toBe(true)
    expect(r.gate.decision).toBe('ALLOW')
    expect(r.readMail).toBe(true)
    expect(r.text).toContain('<untrusted')
    expect(r.citations.length).toBeGreaterThan(0)
  })
  it('a DENY control state stops every read tool before it touches the cache', async () => {
    const deps = await setup({}, EMPTY_MAIL_CONTEXT, { controlState: { permission: 'DENY', execution_mode: 'RECOVERY', escalation: 'NONE' } })
    for (const n of MAIL_READ_TOOL_NAMES) {
      const r = await runMailReadTool(n, {}, deps)
      expect(r.ok).toBe(false)
      expect(r.gate.decision).toBe('DENY')
      expect(r.readMail).toBe(false)
    }
  })
  it('refuses a non-read-only or unknown tool', async () => {
    expect((await runMailReadTool('mail_move', {}, await setup())).ok).toBe(false)
    expect((await runMailReadTool('mail_send', {}, await setup())).ok).toBe(false)
  })
})

describe('mail_search', () => {
  it('filters by sender, folder and text', async () => {
    const deps = await setup()
    const bySender = await runMailReadTool('mail_search', { from: inboxMsg.from.address }, deps)
    expect(bySender.citations.every((c) => mb.messages.find((m) => m.id === c.messageId)!.from.address === inboxMsg.from.address)).toBe(true)
    const sent = await runMailReadTool('mail_search', { folder: 'Sent' }, deps)
    expect(sent.citations.length).toBeGreaterThan(0)
    const word = inboxMsg.subject.split(' ')[0]
    const t = await runMailReadTool('mail_search', { text: word }, deps)
    expect(t.citations.some((c) => c.messageId === inboxMsg.id)).toBe(true)
    expect((await runMailReadTool('mail_search', { folder: 'Nope' }, deps)).ok).toBe(false)
  })
  it('never reads an excluded folder: no header, no snippet, no match on its body', async () => {
    const deps = await setup({ excludedFolders: ['Sent'] })
    const r = await runMailReadTool('mail_search', {}, deps)
    expect(r.withheld).toBeGreaterThan(0)
    expect(r.citations.some((c) => c.messageId === sentMsg.id)).toBe(false)
    expect(r.text).not.toContain(sentMsg.subject)
    // searching for text only the excluded message contains reveals nothing
    const probe = await runMailReadTool('mail_search', { text: sentMsg.textBody.slice(0, 30) }, deps)
    expect(probe.citations.some((c) => c.messageId === sentMsg.id)).toBe(false)
    expect(probe.text).not.toContain(sentMsg.subject)
  })
  it('an excluded sender is withheld; an account that is off yields nothing', async () => {
    const r = await runMailReadTool('mail_search', {}, await setup({ excludedSenders: [inboxMsg.from.address] }))
    expect(r.citations.some((c) => c.messageId === inboxMsg.id)).toBe(false)
    const off = await runMailReadTool('mail_search', {}, await setup({ aieliaMayRead: false }))
    expect(off.citations).toEqual([])
    expect(off.readMail).toBe(false)
  })
})

describe('mail_read_thread', () => {
  it('reads the thread the context chip points at', async () => {
    const ctx = addChip(EMPTY_MAIL_CONTEXT, { kind: 'message', messageId: inboxMsg.id, threadId: inboxMsg.threadId })
    const r = await runMailReadTool('mail_read_thread', {}, await setup({}, ctx))
    expect(r.ok).toBe(true)
    expect(r.text).toContain(inboxMsg.textBody.slice(0, 20))
  })
  it('with no id and no chip it does not guess', async () => {
    const r = await runMailReadTool('mail_read_thread', {}, await setup())
    expect(r.ok).toBe(false)
    expect(r.readMail).toBe(false)
  })
  it('an excluded thread yields no text', async () => {
    const r = await runMailReadTool('mail_read_thread', { threadId: sentMsg.threadId }, await setup({ excludedFolders: ['fld-sent'] }))
    expect(r.ok).toBe(false)
    expect(r.text).not.toContain(sentMsg.textBody.slice(0, 20))
    expect(r.readMail).toBe(false)
  })
})

describe('mail_list_folders', () => {
  it('lists folders and does not call them mail text', async () => {
    const r = await runMailReadTool('mail_list_folders', {}, await setup({ excludedFolders: ['Projects'] }))
    expect(r.text).toContain('Inbox')
    expect(r.text).toContain('(excluded from Aielia)')
    expect(r.readMail).toBe(false)
  })
})

describe('mail_summarise', () => {
  const client = createScriptedLLMClient({ sideResponses: [['You summarise email for their owner', 'A short summary.']] })
  const summarise = async (system: string, user: string, seen: string[] = []) => {
    seen.push(user)
    return (await client.callChatStructured([{ role: 'system', content: system }, { role: 'user', content: user }])).content
  }
  it('summarises what the chips point at, via the marker', async () => {
    const seen: string[] = []
    const ctx = addChip(EMPTY_MAIL_CONTEXT, { kind: 'thread', threadId: inboxMsg.threadId })
    const r = await runMailReadTool('mail_summarise', {}, await setup({}, ctx, { summarise: (s, u) => summarise(s, u, seen) }))
    expect(r.text).toBe('A short summary.')
    expect(r.readMail).toBe(true)
    expect(seen[0]).toContain(inboxMsg.textBody.slice(0, 20))
  })
  it('never calls the model when everything is excluded', async () => {
    const seen: string[] = []
    const ctx = addChip(EMPTY_MAIL_CONTEXT, { kind: 'thread', threadId: sentMsg.threadId })
    const r = await runMailReadTool('mail_summarise', {}, await setup({ excludedFolders: ['fld-sent'] }, ctx, { summarise: (s, u) => summarise(s, u, seen) }))
    expect(r.ok).toBe(false)
    expect(seen).toEqual([])
  })
  it('only the readable messages of a mixed view reach the model', async () => {
    const seen: string[] = []
    const ctx = addChip(EMPTY_MAIL_CONTEXT, { kind: 'account', accountId: mb.account.id })
    await runMailReadTool('mail_summarise', {}, await setup({ excludedFolders: ['fld-sent'] }, ctx, { summarise: (s, u) => summarise(s, u, seen) }))
    expect(seen[0]).toContain(inboxMsg.textBody.slice(0, 20))
    expect(seen[0]).not.toContain(sentMsg.textBody.slice(0, 30))
  })
  it('a failing model reports failure, not a made-up summary', async () => {
    const ctx = addChip(EMPTY_MAIL_CONTEXT, { kind: 'thread', threadId: inboxMsg.threadId })
    const r = await runMailReadTool('mail_summarise', {}, await setup({}, ctx, { summarise: async () => { throw new Error('boom') } }))
    expect(r.ok).toBe(false)
    expect(r.text).toContain('boom')
  })
})

describe('mail_list_todo', () => {
  const item = (id: string, threadId: string | undefined, status: TodoItem['status'] = 'open'): TodoItem => ({
    id, threadId, title: `Item ${id}`, origin: 'triage', status, group: 'do_now', reason: 'Because.', createdAt: '2026-11-13T09:00:00.000Z',
  })
  it('lists open items by default and withholds items from excluded threads', async () => {
    const todos = [item('a', inboxMsg.threadId), item('b', sentMsg.threadId), item('c', undefined), item('d', inboxMsg.threadId, 'done')]
    const r = await runMailReadTool('mail_list_todo', {}, await setup({ excludedFolders: ['fld-sent'] }, EMPTY_MAIL_CONTEXT, { listTodo: async () => todos }))
    expect(r.text).toContain('Item a')
    expect(r.text).toContain('Item c')
    expect(r.text).not.toContain('Item b')
    expect(r.text).not.toContain('Item d')
    expect(r.withheld).toBe(1)
    const done = await runMailReadTool('mail_list_todo', { status: 'done' }, await setup({}, EMPTY_MAIL_CONTEXT, { listTodo: async () => todos }))
    expect(done.text).toContain('Item d')
  })
})

describe('context chips', () => {
  it('opening a message replaces the previous "this" chip; removing one removes it', () => {
    let ctx = addChip(EMPTY_MAIL_CONTEXT, { kind: 'message', messageId: 'm1' })
    ctx = addChip(ctx, { kind: 'view', folderId: 'fld-inbox', folderName: 'Inbox' })
    ctx = addChip(ctx, { kind: 'message', messageId: 'm2' })
    expect(ctx.chips.map((c) => c.kind)).toEqual(['view', 'message'])
    expect(chipLabel(ctx.chips[0])).toBe('Everything in Inbox')
    ctx = removeChip(ctx, ctx.chips[1])
    expect(ctx.chips.map((c) => c.kind)).toEqual(['view'])
  })
  it('chips decide what "this one", "these" and "everything here" mean', async () => {
    const deps = await setup()
    const one = await resolveContext(addChip(EMPTY_MAIL_CONTEXT, { kind: 'message', messageId: inboxMsg.id }), deps.cache, mb.account.id)
    expect(one.messages.map((m) => m.id)).toEqual([inboxMsg.id])
    const two = await resolveContext(addChip(EMPTY_MAIL_CONTEXT, { kind: 'selection', messageIds: [inboxMsg.id, sentMsg.id] }), deps.cache, mb.account.id)
    expect(two.messages.map((m) => m.id).sort()).toEqual([inboxMsg.id, sentMsg.id].sort())
    const view = await resolveContext(addChip(EMPTY_MAIL_CONTEXT, { kind: 'view', folderId: 'fld-sent' }), deps.cache, mb.account.id)
    expect(view.messages.every((m) => m.folderIds.includes('fld-sent'))).toBe(true)
    const none = await resolveContext(EMPTY_MAIL_CONTEXT, deps.cache, mb.account.id)
    expect(none.messages).toEqual([])
    const acct = await resolveContext(addChip(EMPTY_MAIL_CONTEXT, { kind: 'account', accountId: mb.account.id }), deps.cache, mb.account.id)
    expect(acct.messages.length).toBe(mb.messages.length)
  })
})
