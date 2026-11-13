import type { EmailCacheFactory } from './cache.js'
import type { Message, Thread } from './model.js'

/**
 * A reusable conformance suite for `EmailCache` implementations (in-memory, IndexedDB, SQLite on desktop).
 * Framework-free: each check throws on failure, so a test file just loops over `CACHE_CONFORMANCE_CHECKS`.
 */

export interface CacheConformanceCheck {
  name: string
  run: (make: EmailCacheFactory) => Promise<void>
}

/** Time bound for listing a window out of `LARGE_CACHE_SIZE` messages on the in-memory cache. */
export const LARGE_CACHE_SIZE = 50_000
export const LARGE_WINDOW_BOUND_MS = 2_000

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`cache conformance: ${msg}`)
}
function same(a: unknown, b: unknown, msg: string): void {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

const ACCOUNT = 'acct-c'
export function conformanceMessage(n: number, over: Partial<Message> = {}): Message {
  const id = `m${String(n).padStart(6, '0')}`
  const day = String(1 + (n % 28)).padStart(2, '0')
  const hour = String(Math.floor(n / 28) % 24).padStart(2, '0')
  return {
    id,
    accountId: ACCOUNT,
    threadId: `t${n % 1000}`,
    providerId: `p-${id}`,
    folderIds: ['inbox'],
    from: { address: `sender${n % 50}@example.com` },
    to: [{ address: 'me@example.org' }],
    cc: [],
    subject: `Subject ${n}`,
    date: `2026-03-${day}T${hour}:00:00.000Z`,
    headers: {},
    textBody: `Body ${n}`,
    attachments: [],
    flags: { read: n % 2 === 0, starred: n % 7 === 0, draft: false },
    ...over,
  }
}
function conformanceThread(n: number, over: Partial<Thread> = {}): Thread {
  return {
    id: `t${n}`,
    accountId: ACCOUNT,
    providerId: `pt${n}`,
    subject: `Thread ${n}`,
    messageIds: [],
    folderIds: ['inbox'],
    participants: [],
    lastMessageAt: `2026-04-${String(1 + n).padStart(2, '0')}T00:00:00.000Z`,
    unread: false,
    ...over,
  }
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

export const CACHE_CONFORMANCE_CHECKS: CacheConformanceCheck[] = [
  {
    name: 'upserts and reads back a message, thread and folders; unknown ids are undefined',
    async run(make) {
      const c = await make()
      const m = conformanceMessage(1)
      await c.upsertMessages([m])
      await c.upsertThreads([conformanceThread(1)])
      await c.upsertFolders([{ id: 'inbox', accountId: ACCOUNT, providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 0 }])
      same(await c.getMessage(m.id), m, 'message round trip')
      assert((await c.getThread('t1'))?.subject === 'Thread 1', 'thread round trip')
      assert((await c.getFolders(ACCOUNT)).length === 1, 'folder round trip')
      assert((await c.getFolders('other')).length === 0, 'folders are per account')
      assert((await c.getMessage('nope')) === undefined, 'unknown message')
      assert((await c.getThread('nope')) === undefined, 'unknown thread')
    },
  },
  {
    name: 'upsert replaces a record and moves it between folder indexes',
    async run(make) {
      const c = await make()
      await c.upsertMessages([conformanceMessage(1), conformanceMessage(2)])
      await c.upsertMessages([conformanceMessage(1, { folderIds: ['archive'], subject: 'changed' })])
      same(ids((await c.queryMessages({ folderId: 'inbox' }, { offset: 0, limit: 10 })).items), ['m000002'], 'inbox after move')
      same(ids((await c.queryMessages({ folderId: 'archive' }, { offset: 0, limit: 10 })).items), ['m000001'], 'archive after move')
      assert((await c.getMessage('m000001'))?.subject === 'changed', 'replaced content')
    },
  },
  {
    name: 'deleting a message removes it from get and from every query',
    async run(make) {
      const c = await make()
      await c.upsertMessages([conformanceMessage(1), conformanceMessage(2)])
      await c.queryMessages({ folderId: 'inbox' }, { offset: 0, limit: 10 })
      await c.deleteMessages(['m000001'])
      assert((await c.getMessage('m000001')) === undefined, 'get after delete')
      const r = await c.queryMessages({ folderId: 'inbox' }, { offset: 0, limit: 10 })
      same(ids(r.items), ['m000002'], 'folder query after delete')
      assert(r.total === 1, 'total after delete')
      same(ids((await c.queryMessages({}, { offset: 0, limit: 10 })).items), ['m000002'], 'unfiltered query after delete')
      await c.deleteMessages(['never-existed'])
    },
  },
  {
    name: 'deleting a thread removes it from get and list',
    async run(make) {
      const c = await make()
      await c.upsertThreads([conformanceThread(1), conformanceThread(2)])
      await c.deleteThreads(['t1'])
      assert((await c.getThread('t1')) === undefined, 'get after delete')
      same(ids((await c.listThreads('inbox', { offset: 0, limit: 10 })).items), ['t2'], 'list after delete')
    },
  },
  {
    name: 'queries by sender, thread, flags and date range',
    async run(make) {
      const c = await make()
      const msgs = Array.from({ length: 60 }, (_, i) => conformanceMessage(i))
      await c.upsertMessages(msgs)
      const win = { offset: 0, limit: 1000 }
      const bySender = await c.queryMessages({ sender: 'SENDER3@example.com' }, win)
      same(bySender.items.length, msgs.filter((m) => m.from.address === 'sender3@example.com').length, 'sender (case-insensitive)')
      const byThread = await c.queryMessages({ threadId: 't5' }, win)
      same(ids(byThread.items), ['m000005'], 'thread')
      const unread = await c.queryMessages({ read: false }, win)
      assert(unread.total === msgs.filter((m) => !m.flags.read).length && unread.items.every((m) => !m.flags.read), 'unread flag')
      const starred = await c.queryMessages({ starred: true, read: true }, win)
      assert(starred.items.every((m) => m.flags.starred && m.flags.read) && starred.total > 0, 'combined flags')
      const ranged = await c.queryMessages({ since: '2026-03-05T00:00:00.000Z', before: '2026-03-10T00:00:00.000Z' }, win)
      assert(ranged.total > 0 && ranged.items.every((m) => m.date >= '2026-03-05T00:00:00.000Z' && m.date < '2026-03-10T00:00:00.000Z'), 'date range')
      same((await c.queryMessages({ sender: 'nobody@example.com' }, win)).items, [], 'no match')
    },
  },
  {
    name: 'windows are newest first, stable, and report the whole total',
    async run(make) {
      const c = await make()
      await c.upsertMessages(Array.from({ length: 30 }, (_, i) => conformanceMessage(i)))
      const all = await c.queryMessages({ folderId: 'inbox' }, { offset: 0, limit: 100 })
      assert(all.total === 30 && all.items.length === 30, 'full window')
      for (let i = 1; i < all.items.length; i++) assert(all.items[i - 1]!.date >= all.items[i]!.date, 'sorted newest first')
      const w = await c.queryMessages({ folderId: 'inbox' }, { offset: 10, limit: 5 })
      same(ids(w.items), ids(all.items.slice(10, 15)), 'window slice')
      assert(w.total === 30, 'total is the whole view')
      same((await c.queryMessages({ folderId: 'inbox' }, { offset: 40, limit: 5 })).items, [], 'past the end')
      same((await c.queryMessages({ folderId: 'inbox' }, { offset: 0, limit: 0 })).items, [], 'zero limit')
    },
  },
  {
    name: 'threads list newest activity first with a window',
    async run(make) {
      const c = await make()
      await c.upsertThreads([conformanceThread(3), conformanceThread(1), conformanceThread(2, { folderIds: ['archive'] })])
      same(ids((await c.listThreads('inbox', { offset: 0, limit: 10 })).items), ['t3', 't1'], 'inbox threads')
      same(ids((await c.listThreads(undefined, { offset: 1, limit: 1 })).items), ['t2'], 'window over all')
    },
  },
  {
    name: 'sync tokens are stored per account and can be cleared',
    async run(make) {
      const c = await make()
      assert((await c.getSyncToken('a')) === undefined, 'empty at start')
      await c.setSyncToken('a', 'v1')
      await c.setSyncToken('b', 'v9')
      await c.setSyncToken('a', 'v2')
      assert((await c.getSyncToken('a')) === 'v2' && (await c.getSyncToken('b')) === 'v9', 'per account')
      await c.setSyncToken('a', undefined)
      assert((await c.getSyncToken('a')) === undefined, 'cleared')
    },
  },
  {
    name: 'clearAccount drops one account and leaves the others',
    async run(make) {
      const c = await make()
      await c.upsertMessages([conformanceMessage(1), conformanceMessage(2, { accountId: 'acct-d' })])
      await c.setSyncToken(ACCOUNT, 'v1')
      await c.clearAccount(ACCOUNT)
      assert((await c.getMessage('m000001')) === undefined, 'cleared message')
      assert((await c.getMessage('m000002')) !== undefined, 'other account kept')
      assert((await c.getSyncToken(ACCOUNT)) === undefined, 'cleared token')
    },
  },
  {
    name: 'returned records are copies, not live references',
    async run(make) {
      const c = await make()
      await c.upsertMessages([conformanceMessage(1)])
      const got = (await c.getMessage('m000001'))!
      got.subject = 'mutated'
      assert((await c.getMessage('m000001'))!.subject === 'Subject 1', 'mutation leaked into the cache')
    },
  },
  {
    name: `lists a window from ${LARGE_CACHE_SIZE} messages within ${LARGE_WINDOW_BOUND_MS} ms`,
    async run(make) {
      const c = await make()
      const batch: Message[] = []
      for (let i = 0; i < LARGE_CACHE_SIZE; i++) batch.push(conformanceMessage(i, { folderIds: [i % 2 ? 'inbox' : 'archive'] }))
      await c.upsertMessages(batch)
      const t0 = Date.now()
      const r = await c.queryMessages({ folderId: 'inbox' }, { offset: 1000, limit: 50 })
      const r2 = await c.queryMessages({ folderId: 'inbox', read: false }, { offset: 0, limit: 50 })
      const ms = Date.now() - t0
      assert(r.total === LARGE_CACHE_SIZE / 2 && r.items.length === 50, 'window size and total')
      assert(r2.items.length === 50, 'filtered window')
      assert(ms <= LARGE_WINDOW_BOUND_MS, `windows took ${ms} ms, bound ${LARGE_WINDOW_BOUND_MS} ms`)
    },
  },
]
