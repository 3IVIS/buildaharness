import type { EmailProvider } from './provider.js'
import { EmailProviderError } from './provider.js'
import type { Folder, Message } from './model.js'
import type { SyntheticMailbox } from './synthetic-mailbox.js'

/**
 * A reusable conformance suite for `EmailProvider` implementations (the in-memory fake, Gmail over fixtures, and later
 * Graph and IMAP). Framework-free: each check throws on failure, so a test file loops over
 * `PROVIDER_CONFORMANCE_CHECKS`. Checks find folders by kind and never assume folder ids, because ids are provider
 * specific. Every provider factory is handed the same synthetic mailbox.
 */

export type ProviderFactory = (mailbox: SyntheticMailbox) => EmailProvider | Promise<EmailProvider>

export interface ProviderConformanceCheck {
  name: string
  run: (make: ProviderFactory) => Promise<void>
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`provider conformance: ${msg}`)
}
async function rejectsWith(p: Promise<unknown>, code: string, msg: string): Promise<void> {
  try {
    await p
  } catch (e) {
    assert(e instanceof EmailProviderError && e.code === code, `${msg}: expected ${code}, got ${e instanceof EmailProviderError ? e.code : String(e)}`)
    return
  }
  throw new Error(`provider conformance: ${msg}: expected a rejection (${code})`)
}
function folderOf(folders: Folder[], kind: Folder['kind'], what = kind): Folder {
  const f = folders.find((x) => x.kind === kind)
  assert(f, `no ${what} folder`)
  return f
}
function customFolder(folders: Folder[], not?: string): Folder {
  const f = folders.find((x) => x.kind === 'custom' && x.id !== not)
  assert(f, 'no custom folder')
  return f
}
async function firstUnreadInbox(p: EmailProvider): Promise<{ msg: Message; inbox: Folder; folders: Folder[] }> {
  const folders = await p.listFolders()
  const inbox = folderOf(folders, 'inbox')
  const msg = (await p.listMessages(inbox.id, { limit: 50 })).items.find((m) => !m.flags.read)
  assert(msg, 'no unread inbox message')
  return { msg, inbox, folders }
}

export const PROVIDER_CONFORMANCE_CHECKS: ProviderConformanceCheck[] = [
  {
    name: 'lists folders with kinds and unread counts',
    async run(make) {
      const folders = await (await make(freshMailbox())).listFolders()
      for (const k of ['inbox', 'sent', 'drafts', 'trash'] as const) folderOf(folders, k)
      assert(folderOf(folders, 'inbox').unreadCount > 0, 'inbox has unread messages')
      for (const f of folders) assert(f.id && f.accountId && f.name, 'folder fields set')
    },
  },
  {
    name: 'pages messages without repeats, and pages threads',
    async run(make) {
      const p = await make(freshMailbox())
      const inbox = folderOf(await p.listFolders(), 'inbox')
      const all: string[] = []
      let token: string | undefined
      do {
        const pg = await p.listMessages(inbox.id, { limit: 4, pageToken: token })
        assert(pg.items.length <= 4, 'page limit respected')
        all.push(...pg.items.map((m) => m.id))
        token = pg.nextPageToken
      } while (token)
      assert(new Set(all).size === all.length, 'no repeated message across pages')
      assert(all.length > 4, 'more than one page')
      const th = await p.listThreads(inbox.id, { limit: 3 })
      assert(th.items.length === 3 && th.nextPageToken !== undefined, 'thread page of 3 with a next token')
      await rejectsWith(p.listMessages('no-such-folder'), 'not_found', 'unknown folder')
    },
  },
  {
    name: 'fetches a message and its thread; unknown ids are not_found',
    async run(make) {
      const p = await make(freshMailbox())
      const { msg } = await firstUnreadInbox(p)
      const got = await p.getMessage(msg.id)
      assert(got.id === msg.id && got.subject === msg.subject && got.from.address === msg.from.address, 'message round-trips')
      assert(got.textBody.length > 0, 'text body present')
      const { thread, messages } = await p.getThread(msg.threadId)
      assert(messages.length === thread.messageIds.length && messages.some((m) => m.id === msg.id), 'thread holds its messages')
      await rejectsWith(p.getMessage('no-such-message'), 'not_found', 'unknown message')
      await rejectsWith(p.getThread('no-such-thread'), 'not_found', 'unknown thread')
    },
  },
  {
    name: 'returns copies, not live state',
    async run(make) {
      const p = await make(freshMailbox())
      const { msg } = await firstUnreadInbox(p)
      msg.subject = 'changed locally'
      assert((await p.getMessage(msg.id)).subject !== 'changed locally', 'a local edit does not reach the provider')
    },
  },
  {
    name: 'searches by text, sender, unread state and folder',
    async run(make) {
      const p = await make(freshMailbox())
      const folders = await p.listFolders()
      assert((await p.search({ text: 'report' })).items.length > 0, 'text search finds messages')
      assert((await p.search({ from: 'news@' })).items.length > 0, 'sender search finds messages')
      const unread = (await p.search({ unreadOnly: true })).items
      assert(unread.length > 0 && unread.every((m) => !m.flags.read), 'unread search returns only unread')
      assert((await p.search({ unreadOnly: true, folderId: folderOf(folders, 'sent').id })).items.length === 0, 'sent folder has nothing unread')
      assert((await p.search({ text: 'zzzqqq-no-such-text' })).items.length === 0, 'nonsense finds nothing')
    },
  },
  {
    name: 'moves, labels, flags and marks read',
    async run(make) {
      const p = await make(freshMailbox())
      const { msg, inbox, folders } = await firstUnreadInbox(p)
      const dest = customFolder(folders)
      await p.move([msg.id], dest.id)
      const moved = await p.getMessage(msg.id)
      assert(moved.folderIds.length === 1 && moved.folderIds[0] === dest.id, 'move leaves the destination as the only folder')
      await p.label([msg.id], inbox.id, true)
      assert(new Set((await p.getMessage(msg.id)).folderIds).size === 2, 'label adds a folder')
      await p.label([msg.id], inbox.id, false)
      assert((await p.getMessage(msg.id)).folderIds.join() === dest.id, 'label removal restores one folder')
      await p.flag([msg.id], true)
      await p.markRead([msg.id], true)
      const m = await p.getMessage(msg.id)
      assert(m.flags.starred && m.flags.read, 'flag and read applied')
      await p.markRead([msg.id], false)
      assert(!(await p.getMessage(msg.id)).flags.read, 'unread applied')
      await rejectsWith(p.move([msg.id], 'no-such-folder'), 'not_found', 'move to unknown folder')
      await rejectsWith(p.flag(['no-such-message'], true), 'not_found', 'flag unknown message')
      await rejectsWith(p.markRead([msg.id, 'no-such-message'], true), 'not_found', 'a bad id changes nothing')
    },
  },
  {
    name: 'keeps the thread in step with its messages',
    async run(make) {
      const p = await make(freshMailbox())
      const { msg } = await firstUnreadInbox(p)
      await p.markRead([msg.id], true)
      assert((await p.getThread(msg.threadId)).thread.unread === false, 'thread read once its only unread message is read')
    },
  },
  {
    name: 'creates a draft and sends it',
    async run(make) {
      const p = await make(freshMailbox())
      const folders = await p.listFolders()
      const d = await p.createDraft({ to: [{ address: 'x@example.com', name: 'Xia Test' }], subject: 'Grüße — Hi', textBody: 'Hello\nsecond line ✓' })
      assert(d.flags.draft && d.subject === 'Grüße — Hi' && d.textBody.trim() === 'Hello\nsecond line ✓', 'draft keeps its subject and body exactly')
      assert(d.to[0]?.address === 'x@example.com', 'draft recipient kept')
      assert((await p.listMessages(folderOf(folders, 'drafts').id)).items.some((x) => x.id === d.id), 'draft listed in drafts')
      const sent = await p.send(d.id)
      assert(!sent.flags.draft && sent.folderIds.includes(folderOf(folders, 'sent').id), 'sent message is in sent and no longer a draft')
      await rejectsWith(p.send(sent.id), 'invalid_argument', 'sending a sent message')
      await rejectsWith(p.createDraft({ to: [], subject: '', textBody: '' }), 'invalid_argument', 'draft without recipient')
      await rejectsWith(p.createDraft({ threadId: 'no-such-thread', to: [{ address: 'x@example.com' }], subject: '', textBody: '' }), 'not_found', 'draft in unknown thread')
      const { msg } = await firstUnreadInbox(p)
      const reply = await p.createDraft({ threadId: msg.threadId, to: [msg.from], subject: `Re: ${msg.subject}`, textBody: 'Thanks.' })
      assert(reply.threadId === msg.threadId, 'a reply draft stays in its thread')
    },
  },
  {
    name: 'delete moves to trash, then removes for good',
    async run(make) {
      const p = await make(freshMailbox())
      const { msg, folders } = await firstUnreadInbox(p)
      const trash = folderOf(folders, 'trash')
      await p.delete([msg.id])
      assert((await p.getMessage(msg.id)).folderIds.join() === trash.id, 'first delete moves to trash')
      await p.delete([msg.id])
      await rejectsWith(p.getMessage(msg.id), 'not_found', 'second delete removes for good')
    },
  },
  {
    name: 'reports incremental changes from a sync token',
    async run(make) {
      const p = await make(freshMailbox())
      const start = await p.listChanges()
      assert(start.changes.length === 0 && !start.fullResyncNeeded && start.syncToken, 'no token: empty set and a token')
      assert((await p.listChanges(start.syncToken)).changes.length === 0, 'nothing changed yet')
      const { msg } = await firstUnreadInbox(p)
      await p.markRead([msg.id], true)
      await p.flag([msg.id], true)
      const c = await p.listChanges(start.syncToken)
      assert(!c.fullResyncNeeded, 'no resync needed')
      assert(c.changes.filter((x) => x.messageId === msg.id).length === 1 && c.changes.some((x) => x.type === 'upsert' && x.messageId === msg.id), 'one upsert for the changed message')
      assert((await p.listChanges(c.syncToken)).changes.length === 0, 'the new token is clean')
      const folders = await p.listFolders()
      await p.delete([msg.id])
      await p.delete([msg.id])
      const d = await p.listChanges(c.syncToken)
      assert(d.changes.some((x) => x.type === 'delete' && x.messageId === msg.id), 'permanent delete reported')
      assert(folders.length > 0, 'folders still listed')
    },
  },
  {
    name: 'asks for a full resync when the token is unknown',
    async run(make) {
      const p = await make(freshMailbox())
      const r = await p.listChanges('garbage')
      assert(r.fullResyncNeeded && r.syncToken, 'a garbage token needs a full resync and carries a fresh token')
      assert(!(await p.listChanges(r.syncToken)).fullResyncNeeded, 'the fresh token works')
    },
  },
]

import { generateSyntheticMailbox } from './synthetic-mailbox.js'
function freshMailbox(): SyntheticMailbox {
  return generateSyntheticMailbox({ seed: 2 })
}

/** Run every check against a factory; used by test files and by hosts that want a quick self-test. */
export async function runProviderConformance(make: ProviderFactory): Promise<void> {
  for (const c of PROVIDER_CONFORMANCE_CHECKS) await c.run(make)
}
