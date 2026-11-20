import { describe, expect, it } from 'vitest'
import type { Folder, Message } from './model.js'
import { InMemoryJunkStore, classifyJunk, exactJunkVerdict, learnJunkSignals } from './junk.js'
import { InMemoryTriageStore } from './triage.js'
import { classifyLocalFolder, resolveFolderKinds } from './local-source.js'
import { LocalMailProvider } from './providers/local-mail.js'
import { FixtureLocalSource, FIXTURE_LOCAL_ACCOUNT } from './local-fixture-source.js'
import { generateSyntheticMailbox } from './synthetic-mailbox.js'

// Defects found by running the capabilities on a real Apple Mail store (2026-11-20): see publishing/email/LIVE-TESTING.md.

const folders: Folder[] = [
  { id: 'in', accountId: 'a', providerId: 'in', name: 'INBOX', kind: 'inbox', unreadCount: 0 },
  { id: 'junk', accountId: 'a', providerId: 'j', name: 'Spam', kind: 'junk', unreadCount: 0 },
]
let n = 0
const msg = (from: string, folder: string, extra: Partial<Message> = {}): Message => {
  n += 1
  return {
    id: `m${n}`, accountId: 'a', threadId: `t${n}`, providerId: `p${n}`, folderIds: [folder], from: { address: from }, to: [{ address: 'me@owner.example' }], cc: [], subject: 's',
    date: '2026-11-01T00:00:00.000Z', headers: {}, textBody: 'body', attachments: [], flags: { read: false, starred: false, draft: false }, ...extra,
  }
}

describe('learned junk signals must be pure', () => {
  it('does not learn a domain that also sends real mail (a free-mail provider)', () => {
    const msgs = [
      ...['a', 'b', 'c'].map((u) => msg(`${u}@mailer.example`, 'junk')),
      ...['x', 'y', 'z'].map((u) => msg(`${u}@free-mail.example`, 'junk')),
      ...Array.from({ length: 12 }, (_, i) => msg(`person${i}@free-mail.example`, 'in', { flags: { read: true, starred: false, draft: false } })),
    ]
    const s = learnJunkSignals(msgs, folders, ['me@owner.example'])
    expect(s.junkDomains).toEqual(['mailer.example'])
  })
  it('does not learn a sender that is mostly in the inbox', () => {
    const msgs = [msg('s@x.example', 'junk'), msg('s@x.example', 'junk'), ...Array.from({ length: 6 }, () => msg('s@x.example', 'in', { flags: { read: true, starred: false, draft: false } }))]
    expect(learnJunkSignals(msgs, folders, ['me@owner.example']).junkSenders).toEqual([])
  })
})

describe('the learned layer obeys the reply guard', () => {
  const learned = { junkSenders: ['pitch@mailer.example'], junkDomains: [], correspondents: [] }
  const base = { account: { address: 'me@owner.example', aieliaMayRead: true, excludedFolders: [], excludedSenders: [] }, folders, signals: learned, model: async () => '{"junk":[]}' }
  it('exact spam on a thread triaged as needing a reply is only unsure', async () => {
    const m = msg('pitch@mailer.example', 'in')
    const triage = new InMemoryTriageStore()
    await triage.put({ threadId: m.threadId, accountId: 'a', category: 'person', needsReply: true, priority: 'high', urgency: 'soon', reason: 'asks a question', userOverridden: false, reviewedAt: '2026-11-01T00:00:00.000Z' } as never)
    const store = new InMemoryJunkStore()
    await classifyJunk([{ thread: { id: m.threadId, accountId: 'a', providerId: 'p', subject: 's', messageIds: [m.id], folderIds: ['in'], participants: [], lastMessageAt: m.date, unread: true }, messages: [m] }], { ...base, store, triage })
    expect((await store.get(m.threadId))?.verdict).toBe('unsure')
  })
  it('exact spam on a thread nobody has reviewed is only unsure', async () => {
    const m = msg('pitch@mailer.example', 'in')
    const store = new InMemoryJunkStore()
    await classifyJunk([{ thread: { id: m.threadId, accountId: 'a', providerId: 'p', subject: 's', messageIds: [m.id], folderIds: ['in'], participants: [], lastMessageAt: m.date, unread: true }, messages: [m] }], { ...base, store, triage: new InMemoryTriageStore() })
    expect((await store.get(m.threadId))?.verdict).toBe('unsure')
  })
  it('the exact layer alone (no triage in play) still decides, as before', () => {
    expect(exactJunkVerdict([msg('pitch@mailer.example', 'in')], learned, ['me@owner.example'])?.verdict).toBe('likely_spam')
  })
})

describe('folder kinds in another language', () => {
  const names = [['INBOX'], ['Gesendete Objekte'], ['Papierkorb'], ['Entwürfe'], ['Github'], ['Projects', 'Banxware']]
  it('asks once with folder names only and keeps only clear answers', async () => {
    const seen: string[] = []
    const kinds = await resolveFolderKinds(names, async (_s, user) => {
      seen.push(user)
      return 'Here you go: {"folders":[{"path":"Gesendete Objekte","kind":"sent"},{"path":"Papierkorb","kind":"trash"},{"path":"Entwürfe","kind":"drafts"},{"path":"Github","kind":"custom"},{"path":"Invented","kind":"junk"},{"path":"Projects/Banxware","kind":"banana"}]}'
    })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0]!).folders).not.toContain('INBOX') // the name table already knew it
    expect(Object.fromEntries(kinds)).toEqual({ 'Gesendete Objekte': 'sent', Papierkorb: 'trash', Entwürfe: 'drafts' })
  })
  it('a failing or garbled model leaves every folder custom', async () => {
    expect((await resolveFolderKinds(names, async () => { throw new Error('down') })).size).toBe(0)
    expect((await resolveFolderKinds(names, async () => 'not json')).size).toBe(0)
  })
  it('the provider uses the resolved kinds', async () => {
    const src = new FixtureLocalSource(generateSyntheticMailbox({ seed: 1 }))
    const boxes = await src.mailboxes()
    const target = boxes.find((b) => classifyLocalFolder(b.path) === 'custom') ?? boxes[0]!
    const provider = new LocalMailProvider({ account: { id: 'x', provider: 'apple_mail', address: 'a@b.c', displayName: 'x', aieliaMayRead: true, excludedFolders: [], excludedSenders: [] }, source: src, localAccountId: target.accountId, folderKinds: new Map([[target.path.join('/'), 'sent']]) })
    expect((await provider.listFolders()).find((f) => f.providerId === target.path.join('/'))?.kind).toBe('sent')
    void FIXTURE_LOCAL_ACCOUNT
  })
})

describe('the owner address is inferred, not assumed', () => {
  it('uses the Sent folder when a kind says which it is, else the inbox recipients', async () => {
    const { inferOwnAddress } = await import('./local-source.js')
    const src = new FixtureLocalSource(generateSyntheticMailbox({ seed: 1 }))
    const boxes = await src.mailboxes()
    const kindOf = (p: readonly string[]) => classifyLocalFolder(p)
    const a = await inferOwnAddress(src, boxes[0]!.accountId, kindOf)
    expect(a).toMatch(/@/)
    // With no sent or inbox folder recognised, nothing is guessed.
    expect(await inferOwnAddress(src, boxes[0]!.accountId, () => 'custom')).toBeUndefined()
  })
})
