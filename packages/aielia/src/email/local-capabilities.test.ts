import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FixtureLocalSource, FIXTURE_LOCAL_ACCOUNT } from './local-fixture-source.js'
import { LocalMailProvider, type LocalMailActions, type LocalMessageRef } from './providers/local-mail.js'
import { syncForWindow, windowSince } from './review-window.js'
import { runCatchUp, estimateCatchUp } from './catch-up.js'
import { InMemoryTriageStore } from './triage.js'
import { InMemoryJunkStore, classifyJunk, learnJunkSignals } from './junk.js'
import { RuleStore, applyRulesToNewMail, approveRule } from './rules.js'
import { createRuleGate, correspondentsOf } from './rule-gate.js'
import { EmailActionLog, TurnCeiling, type ActionContext } from './action-log.js'
import { OrganiseSession, SnoozeStore } from './organise-tools.js'
import { runMailReadTool } from './mail-tools.js'
import { searchMail } from './mail-search.js'
import { generateLabelledCorpus } from './labelled-corpus.js'
import type { SettingsStore } from '../writer/write-permissions.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const store = (): SettingsStore => { const m = new Map<string, unknown>(); return { getSetting: async (k) => m.get(k), setSetting: async (k, v) => { m.set(k, v) } } }

async function setup() {
  const corpus = generateLabelledCorpus({ seed: 9 })
  const source = new FixtureLocalSource(corpus.mailbox)
  const moves: Array<{ refs: LocalMessageRef[]; dest: string[] }> = []
  const actions: LocalMailActions = {
    async move(refs, dest) { moves.push({ refs, dest }) }, async setRead() { /* not used */ }, async setFlagged() { /* not used */ }, async createDraft() { /* not used */ },
  }
  const account = { ...corpus.mailbox.account, provider: 'apple_mail' as const, aieliaMayRead: true }
  const provider = new LocalMailProvider({ account, source, localAccountId: FIXTURE_LOCAL_ACCOUNT, actions })
  const cache = new InMemoryEmailCache()
  await syncForWindow(provider, cache, store(), 'all', { now: NOW })
  return { corpus, source, provider, cache, account, moves }
}

describe('the capabilities over a mailbox read from a local mail program', () => {
  it('catch-up finds what needs a response from the downloaded mail alone', async () => {
    const { corpus, cache, account } = await setup()
    const triage = new InMemoryTriageStore()
    const model = async (_s: string, u: string): Promise<string> => {
      const ids = [...u.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]!) as string)
      // The threads are named by the program's conversation ids, so the oracle is found through the thread's messages.
      return JSON.stringify({ triage: ids.map((threadId) => ({ threadId, category: 'other', needsReply: /Quick question|Report due|review requested|confirm by Wednesday|above your usual limit/.test(u), priority: 'normal', urgency: 'soon', reason: 'scripted' })) })
    }
    const est = await estimateCatchUp({ account, cache, store: triage, since: windowSince(365, NOW) })
    expect(est.inWindow).toBeGreaterThan(10)
    const r = await runCatchUp({ account, cache, store: triage, model, batchSize: 10 })
    expect(r.status).toBe('complete')
    expect(r.reviewed).toBe(est.toReview)
    expect(r.needsResponse.length).toBeGreaterThan(0)
    expect(corpus.mailbox.threads.length).toBeGreaterThan(0)
  })

  it('spam learns from the Junk folder the program already holds, and the model is not asked about known junk', async () => {
    const { corpus, cache, provider, account } = await setup()
    const folders = await cache.getFolders(account.id)
    const all = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).items
    expect(folders.some((f) => f.kind === 'junk')).toBe(true)
    const signals = learnJunkSignals(all, folders, [account.address])
    expect(signals.junkDomains.length).toBe(3)
    const inboxId = folders.find((f) => f.kind === 'inbox')!.id
    const inbox = (await cache.queryMessages({ folderId: inboxId }, { offset: 0, limit: 1000 })).items
    const threads = new Map<string, typeof inbox>()
    for (const m of inbox) threads.set(m.threadId, [...(threads.get(m.threadId) ?? []), m])
    const asked: string[] = []
    const junk = new InMemoryJunkStore()
    await classifyJunk([...threads].map(([id, messages]) => ({ thread: { id, accountId: account.id, providerId: id, subject: messages[0]!.subject, messageIds: messages.map((m) => m.id), folderIds: [inboxId], participants: [], lastMessageAt: messages[0]!.date, unread: true }, messages })), {
      account, folders, signals, store: junk, model: async (_s, u) => { asked.push(u); return '{"junk":[]}' },
    })
    const spam = junk.all().filter((v) => v.verdict === 'likely_spam')
    expect(spam.length).toBeGreaterThanOrEqual(3)
    expect(asked.join('\n')).not.toMatch(/prize-desk|cheap-pills|wire-transfer-help/)
    expect(corpus.verdicts).toBeDefined()
    expect(provider.account.provider).toBe('apple_mail')
  })

  it('there is no server to search: scope both and server say so, honestly, and the count says what it covered', async () => {
    const { cache, provider, account } = await setup()
    const deps = { account, cache, context: { chips: [] }, provider }
    const r = await runMailReadTool('mail_search', { text: 'anything', scope: 'both' }, deps)
    expect(r.text).toMatch(/read from your mail program, which holds only the mail it downloaded/)
    expect(r.text).not.toMatch(/server was searched too/)
    const c = await runMailReadTool('mail_count', {}, { ...deps, windowSince: '2026-10-01T00:00:00.000Z' })
    expect(c.text).toMatch(/mail your mail program has downloaded/)
    expect((await searchMail({ text: 'x' }, 'server', { account, cache, provider, localOnly: true })).localOnly).toBe(true)
  })

  it('rules file mail through the program\'s own automation, only mail that passes the gate, with the Message-ID', async () => {
    const { corpus, cache, provider, account, moves } = await setup()
    const folders = await cache.getFolders(account.id)
    const archive = folders.find((f) => f.kind === 'archive')!
    const triage = new InMemoryTriageStore()
    for (const m of (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).items) {
      const label = corpus.mailbox.messages.find((x) => x.subject === m.subject && x.from.address === m.from.address)
      const verdict = label ? corpus.verdicts[label.threadId] : undefined
      await triage.put({ threadId: m.threadId, category: verdict === 'needs_response' ? 'person' : 'newsletter', needsReply: verdict === 'needs_response', priority: 'low', urgency: 'none', reason: 'x', userOverridden: false, triagedAt: NOW.toISOString() })
    }
    const gate = createRuleGate(cache, { triage, correspondents: await correspondentsOf(cache, account), ownAddresses: [account.address] })
    const rules = new RuleStore()
    const news = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).items.find((m) => m.headers['list-unsubscribe'] && m.from.address.startsWith('news@'))!
    const rule = { id: rules.nextId(), accountId: account.id, match: { kind: 'sender' as const, address: news.from.address }, action: { type: 'move' as const, target: archive.id }, evidenceMessageIds: [], state: 'proposed' as const, origin: 'learned' as const, createdAt: NOW.toISOString() }
    rules.put(rule); approveRule(rules, rule.id)
    const action: ActionContext = { cache, provider, log: new EmailActionLog(), now: () => NOW.toISOString(), turn: new TurnCeiling() }
    const organise = { account, action, session: new OrganiseSession(), snoozes: new SnoozeStore() }
    const res = await applyRulesToNewMail([news], { account, gate, folders, store: rules, organise })
    expect(res.applied.length + res.pending.length).toBeGreaterThan(0)
    expect(moves.length).toBe(1)
    expect(moves[0]!.dest).toEqual(['Archive'])
    expect(moves[0]!.refs[0]).toMatchObject({ accountId: FIXTURE_LOCAL_ACCOUNT, mailboxPath: ['Inbox'] })
    expect(moves[0]!.refs[0]!.messageIdHeader).toMatch(/^<.+>$/)
  })
})
