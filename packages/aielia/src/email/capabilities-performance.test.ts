import { describe, it, expect } from 'vitest'
import { groupConversations } from './conversation.js'
import { InMemoryEmailCache } from './cache.js'
import { InMemoryTriageStore } from './triage.js'
import { estimateCatchUp, runCatchUp } from './catch-up.js'
import { searchMail } from './mail-search.js'
import type { Message, Thread } from './model.js'

/** Generous bounds: the point is that nothing is quadratic, not a benchmark of this machine. */
const N = 50_000
const mk = (i: number, subject: string, extra: Partial<Message> = {}): Message => ({
  id: `m${i}`, accountId: 'a', threadId: `t${i}`, providerId: `p${i}`, folderIds: ['inbox'], from: { address: `s${i % 500}@example.com` }, to: [{ address: 'o@example.org' }], cc: [],
  subject, date: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), headers: {}, textBody: `body ${i}`, attachments: [], flags: { read: false, starred: false, draft: false }, ...extra,
})

describe('performance on a large mailbox', () => {
  it('groups 50,000 messages, including thousands that share one "Re:" subject, in well under two seconds', () => {
    const msgs = Array.from({ length: N }, (_, i) => mk(i, i % 3 === 0 ? 'Re: Weekly status update' : `Subject number ${i}`))
    const t0 = performance.now()
    const g = groupConversations(msgs)
    const ms = performance.now() - t0
    expect(g.size).toBe(N)
    expect(ms).toBeLessThan(2000)
  })
  it('estimates and runs a catch-up over 5,000 threads in batches without holding everything in the model call', async () => {
    const cache = new InMemoryEmailCache()
    const threads: Thread[] = []
    const msgs: Message[] = []
    for (let i = 0; i < 5000; i++) {
      msgs.push(mk(i, `Thread ${i}`))
      threads.push({ id: `t${i}`, accountId: 'a', providerId: `p${i}`, subject: `Thread ${i}`, messageIds: [`m${i}`], folderIds: ['inbox'], participants: [], lastMessageAt: msgs[i]!.date, unread: true })
    }
    await cache.upsertFolders([{ id: 'inbox', accountId: 'a', providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 0 }])
    await cache.upsertMessages(msgs)
    await cache.upsertThreads(threads)
    const store = new InMemoryTriageStore()
    const account = { id: 'a', provider: 'fake' as const, address: 'o@example.org', displayName: 'O', aieliaMayRead: true, excludedFolders: [], excludedSenders: [] }
    let biggest = 0
    const model = async (_s: string, u: string): Promise<string> => {
      const ids = [...u.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]!) as string)
      biggest = Math.max(biggest, ids.length)
      return JSON.stringify({ triage: ids.map((threadId) => ({ threadId, category: 'other', needsReply: false, priority: 'low', urgency: 'none', reason: 'x' })) })
    }
    const t0 = performance.now()
    const est = await estimateCatchUp({ account, cache, store, batchSize: 25 })
    expect(est).toMatchObject({ inWindow: 5000, toReview: 5000, calls: 200 })
    const r = await runCatchUp({ account, cache, store, model, batchSize: 25 })
    expect(r.reviewed).toBe(5000)
    expect(biggest).toBeLessThanOrEqual(25)
    expect(performance.now() - t0).toBeLessThan(15_000)
  })
  it('a local search over 50,000 cached messages returns quickly and stops at the limit', async () => {
    const cache = new InMemoryEmailCache()
    await cache.upsertMessages(Array.from({ length: N }, (_, i) => mk(i, `Subject ${i}`, { textBody: i % 1000 === 0 ? 'needle in here' : 'hay' })))
    const t0 = performance.now()
    const r = await searchMail({ text: 'needle' }, 'local', { account: { id: 'a' }, cache, limit: 20 })
    expect(r.hits).toHaveLength(20)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
