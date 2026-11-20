import { describe, expect, it } from 'vitest'
import type { Folder, Message } from './model.js'
import { InMemorySenderStore, buildSenderProfiles, classifySenders, parseSenderAnswer, SENDER_SYSTEM_PROMPT, setSenderKind, type SenderProfile } from './sender-profile.js'
import { InMemoryJunkStore, classifyJunk } from './junk.js'
import { InMemoryTriageStore } from './triage.js'
import { FakeEmailProvider } from './fake-provider.js'
import { InMemoryEmailCache } from './cache.js'
import { syncAccount } from './sync.js'
import { generateLabelledCorpus } from './labelled-corpus.js'
import { sampleTriageModel } from './offline-session.js'
import { TRIAGE_SYSTEM_PROMPT } from './triage.js'
import { JUNK_SYSTEM_PROMPT } from './junk.js'
import { EmailWorkbench, type ModelFn } from './workbench.js'

const folders: Folder[] = [
  { id: 'in', accountId: 'a', providerId: 'in', name: 'INBOX', kind: 'inbox', unreadCount: 0 },
  { id: 'junk', accountId: 'a', providerId: 'j', name: 'Junk', kind: 'junk', unreadCount: 0 },
  { id: 'shop', accountId: 'a', providerId: 's', name: 'Shops', kind: 'custom', unreadCount: 0 },
]
let n = 0
const msg = (from: string, folder: string, extra: Partial<Message> = {}): Message => {
  n += 1
  return {
    id: `m${n}`, accountId: 'a', threadId: `t${n}`, providerId: `p${n}`, folderIds: [folder], from: { address: from }, to: [{ address: 'me@owner.example' }], cc: [], subject: `s${n}`,
    date: `2026-11-${String(10 + (n % 9)).padStart(2, '0')}T00:00:00.000Z`, headers: {}, textBody: 'hello', attachments: [], flags: { read: false, starred: false, draft: false }, ...extra,
  }
}
const read = { read: true, starred: false, draft: false }
const account = { aieliaMayRead: true, excludedFolders: [], excludedSenders: [] }

describe('buildSenderProfiles', () => {
  it('counts threads and messages, what the owner kept, junk, bulk headers, failed authentication and who the owner has written to', () => {
    const msgs = [
      msg('news@shop.example', 'in', { headers: { 'list-unsubscribe': '<https://x>' } }), msg('news@shop.example', 'shop', { flags: read }), msg('news@shop.example', 'junk'),
      msg('friend@x.example', 'in'), msg('me@owner.example', 'in', { to: [{ address: 'friend@x.example' }] }),
      msg('bad@evil.example', 'in', { headers: { 'authentication-results': 'mx; spf=fail smtp.mailfrom=evil.example; dkim=none' }, from: { address: 'bad@evil.example', name: 'support@bank.example' } }),
    ]
    const by = new Map(buildSenderProfiles(msgs, folders, ['me@owner.example']).map((p) => [p.sender, p]))
    expect(by.has('me@owner.example')).toBe(false)
    expect(by.get('news@shop.example')).toMatchObject({ threads: 3, messages: 3, kept: 1, inJunk: 1, listHeaders: true, writtenTo: false })
    expect(by.get('friend@x.example')?.writtenTo).toBe(true)
    expect(by.get('bad@evil.example')).toMatchObject({ authFailed: true, flags: ['sender_mismatch'] })
  })
})

const profile = (sender: string, over: Partial<SenderProfile> = {}): SenderProfile => ({
  sender, domain: sender.split('@')[1]!, threads: 1, messages: 1, firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-01T00:00:00.000Z', kept: 0, inJunk: 0, writtenTo: false,
  listHeaders: false, flags: [], authFailed: false, sample: msg(sender, 'in'), ...over,
})

describe('classifySenders', () => {
  it('asks once per sender, in batches, and remembers the answer', async () => {
    const ps = Array.from({ length: 65 }, (_, i) => profile(`s${i}@biz${i}.example`))
    let calls = 0
    const model = async (_s: string, u: string) => { calls++; return JSON.stringify({ senders: [...u.matchAll(/^Sender ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ sender: JSON.parse(m[1]!), kind: 'business_newsletter', reason: 'a company newsletter' })) }) }
    const store = new InMemorySenderStore()
    const r1 = await classifySenders(ps, { account, model, store })
    expect(calls).toBe(3) // 65 senders at 30 a call
    expect(r1.written).toHaveLength(65)
    const r2 = await classifySenders(ps, { account, model, store })
    expect(calls).toBe(3)
    expect(r2.remembered).toBe(65)
  })
  it('a sender the owner has written to is a person, with no model call', async () => {
    let calls = 0
    const store = new InMemorySenderStore()
    await classifySenders([profile('anna@x.example', { writtenTo: true })], { account, model: async () => { calls++; return '{}' }, store })
    expect(calls).toBe(0)
    expect((await store.get('anna@x.example'))?.kind).toBe('person')
  })
  it('an unclear, invented or garbled answer places nobody', async () => {
    const store = new InMemorySenderStore()
    const ps = [profile('a@x.example'), profile('b@y.example')]
    const model = async () => JSON.stringify({ senders: [{ sender: 'a@x.example', kind: 'unknown', reason: 'cannot tell' }, { sender: 'invented@z.example', kind: 'suspicious', reason: 'x' }, { sender: 'b@y.example', kind: 'banana', reason: 'x' }] })
    const r = await classifySenders(ps, { account, model, store })
    expect(r.written).toEqual([])
    // `a` was answered "unknown" (not recorded, so it is asked again later); `b` got an invalid kind and counts as unanswered.
    expect(r.unanswered).toEqual(['b@y.example'])
    expect(await store.get('a@x.example')).toBeUndefined()
    expect(parseSenderAnswer('not json')).toEqual([])
  })
  it('mail reaches the model only wrapped as untrusted, and not at all when Aielia may not read the account', async () => {
    const seen: string[] = []
    const model = async (s: string, u: string) => { seen.push(s + u); return '{"senders":[]}' }
    await classifySenders([profile('a@x.example')], { account, model, store: new InMemorySenderStore() })
    expect(seen[0]).toContain('untrusted_external_content')
    expect(seen[0]).toContain(SENDER_SYSTEM_PROMPT.slice(0, 40))
    seen.length = 0
    await classifySenders([profile('b@y.example')], { account: { ...account, aieliaMayRead: false }, model, store: new InMemorySenderStore() })
    expect(seen).toEqual([])
  })
  it('the owner can pin a sender to a kind', async () => {
    const store = new InMemorySenderStore()
    await setSenderKind(store, 'A@X.example', 'business_newsletter')
    expect(await store.get('a@x.example')).toMatchObject({ kind: 'business_newsletter', basis: 'user' })
  })
})

describe('spam is decided from the sender profile: a business newsletter is never spam', () => {
  const item = (m: Message) => ({ thread: { id: m.threadId, accountId: 'a', providerId: 'p', subject: m.subject, messageIds: [m.id], folderIds: [...m.folderIds], participants: [], lastMessageAt: m.date, unread: true }, messages: [m] })
  const opts = (over: Record<string, unknown> = {}) => ({ account: { ...account, address: 'me@owner.example' }, folders, signals: { junkSenders: [], junkDomains: [], correspondents: [] }, store: new InMemoryJunkStore(), model: async () => '{"junk":[]}', ...over })

  it('a newsletter profile means not spam with no model call, even though the model would have said spam', async () => {
    const m = msg('offers@store.example', 'in')
    let asked = 0
    const o = opts({ model: async () => { asked++; return JSON.stringify({ junk: [{ threadId: m.threadId, verdict: 'likely_spam', reason: 'promotion' }] }) }, profiles: new Map([['offers@store.example', { kind: 'business_newsletter', reason: 'a retailer newsletter' }]]) })
    await classifyJunk([item(m)], o)
    expect(asked).toBe(0)
    expect(await o.store.get(m.threadId)).toMatchObject({ verdict: 'not_spam', basis: 'profile' })
  })
  it('a suspicious sender is spam only once reviewed as not needing a reply; the review covers only the flagged threads', async () => {
    const bad = msg('pay@evil.example', 'in'), good = msg('offers@store.example', 'in')
    const triage = new InMemoryTriageStore()
    const reviewed: string[][] = []
    const o = opts({
      model: async () => '{"junk":[]}', triage,
      profiles: new Map([['pay@evil.example', { kind: 'suspicious', reason: 'impersonates a bank' }], ['offers@store.example', { kind: 'business_newsletter', reason: 'newsletter' }]]),
      review: async (flagged: Array<{ thread: { id: string } }>) => {
        reviewed.push(flagged.map((f) => f.thread.id))
        for (const f of flagged) await triage.put({ threadId: f.thread.id, category: 'other', needsReply: false, priority: 'low', urgency: 'none', reason: 'no ask', userOverridden: false, triagedAt: '2026-11-01T00:00:00.000Z' } as never)
      },
    })
    await classifyJunk([item(bad), item(good)], o)
    expect(reviewed).toEqual([[bad.threadId]])
    expect(await o.store.get(bad.threadId)).toMatchObject({ verdict: 'likely_spam', basis: 'profile' })
    expect((await o.store.get(good.threadId))?.verdict).toBe('not_spam')
  })
  it('a flagged thread that needs a reply is only unsure', async () => {
    const bad = msg('pay@evil.example', 'in')
    const triage = new InMemoryTriageStore()
    const o = opts({
      model: async () => '{"junk":[]}', triage, profiles: new Map([['pay@evil.example', { kind: 'cold_outreach', reason: 'a pitch' }]]),
      review: async (flagged: Array<{ thread: { id: string } }>) => { for (const f of flagged) await triage.put({ threadId: f.thread.id, category: 'person', needsReply: true, priority: 'high', urgency: 'soon', reason: 'asks', userOverridden: false, triagedAt: '2026-11-01T00:00:00.000Z' } as never) },
    })
    await classifyJunk([item(bad)], o)
    expect(await o.store.get(bad.threadId)).toMatchObject({ verdict: 'unsure', basis: 'guard' })
  })
  it('one question per sender: three threads from one unprofiled sender make one model entry', async () => {
    const ms = [msg('x@new.example', 'in'), msg('x@new.example', 'in'), msg('x@new.example', 'in')]
    const prompts: string[] = []
    const o = opts({ model: async (_s: string, u: string) => { prompts.push(u); return JSON.stringify({ junk: [{ threadId: [...u.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]!))[0], verdict: 'not_spam', reason: 'fine' }] }) } })
    await classifyJunk(ms.map(item), o)
    expect(prompts).toHaveLength(1)
    expect([...prompts[0]!.matchAll(/^Thread "/gm)]).toHaveLength(1)
    for (const m of ms) expect((await o.store.get(m.threadId))?.verdict).toBe('not_spam')
  })
})

describe('the workbench spam check on the labelled corpus', () => {
  async function run() {
    const c = generateLabelledCorpus()
    const provider = new FakeEmailProvider(c.mailbox)
    const cache = new InMemoryEmailCache()
    await syncAccount(provider, cache)
    const triage = sampleTriageModel(c.mailbox.categoryByThread)
    let calls = 0
    const model: ModelFn = async (system, user) => {
      calls++
      if (system === SENDER_SYSTEM_PROMPT) {
        return JSON.stringify({ senders: [...user.matchAll(/^Sender ("(?:[^"\\]|\\.)*"): (.*)$/gm)].map((m) => {
          const sender = JSON.parse(m[1]!) as string
          const kind = /prize-desk|cheap-pills|wire-transfer/.test(sender) ? 'suspicious' : /bulkListHeaders=yes/.test(m[2]!) ? 'business_newsletter' : 'person'
          return { sender, kind, reason: 'stub' }
        }) })
      }
      if (system === TRIAGE_SYSTEM_PROMPT) return triage(system, user)
      if (system === JUNK_SYSTEM_PROMPT) return '{"junk":[]}'
      return '{"answer":"x"}'
    }
    const wb = new EmailWorkbench({ provider, cache, model, now: () => '2026-11-02T00:00:00.000Z' })
    await wb.refresh()
    return { wb, c, calls: () => calls }
  }
  it('calls spam only the suspicious senders, never the subscribed promotions, in a handful of model calls', async () => {
    const { wb, c, calls } = await run()
    const v = await wb.spam(90)
    expect(calls()).toBeLessThanOrEqual(5)
    const subjects = v.rows.map((r) => r.subject).join(' | ')
    expect(subjects).not.toMatch(/20% off this weekend/)
    expect(v.rows.length).toBeGreaterThan(0)
    expect(c.traps.length).toBeGreaterThan(0)
  })
  it('groups the senders by kind', async () => {
    const { wb } = await run()
    const v = await wb.senders(90)
    expect(v.total).toBeGreaterThan(3)
    expect(v.groups.map((g) => g.kind)).toEqual(expect.arrayContaining(['suspicious', 'business_newsletter']))
  })
  it('finds a thread in whatever folder it lives in', async () => {
    const { wb } = await run()
    const t = wb.inboxThreads()[0]!.thread.id
    expect(wb.locate(t)).toMatchObject({ messageId: expect.any(String), folderId: expect.any(String) })
    expect(wb.locate('nope')).toBeUndefined()
  })
})
