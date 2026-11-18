import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import { EmailActionLog, TurnCeiling, type ActionContext } from './action-log.js'
import { OrganiseSession, SnoozeStore, type OrganiseDeps } from './organise-tools.js'
import { InMemoryTriageStore } from './triage.js'
import { RuleStore, applyRulesToNewMail, approveRule, learnExactRules, markFiledNeedsAction, matchActiveRules, rescanFiled } from './rules.js'
import { NO_ACTION_CATEGORIES, correspondentsOf, createRuleGate, eligibleMessageIds, threadEligibility } from './rule-gate.js'
import { generateLabelledCorpus, threadMessages, type LabelledCorpus } from './labelled-corpus.js'
import { ruleLeaks, ungatedBulkSenderRules } from './eval-baselines.js'
import type { Message, Triage } from './model.js'

const NOW = '2026-11-18T00:00:00.000Z'
const tri = (o: Partial<Triage> = {}): Triage => ({ threadId: 't', category: 'newsletter', needsReply: false, priority: 'low', urgency: 'none', reason: 'r', userOverridden: false, triagedAt: NOW, ...o })
const m = (from = 'news@lists.example.net', extra: Partial<Message> = {}): Message => ({
  id: 'm1', accountId: 'a', threadId: 't', providerId: 'p', folderIds: ['fld-inbox'], from: { address: from }, to: [{ address: 'owner@example.org' }], cc: [], subject: 's', date: NOW,
  headers: {}, textBody: '', attachments: [], flags: { read: false, starred: false, draft: false }, ...extra,
})
const rec = { correspondents: new Set(['marta@example.com']), ownAddresses: ['owner@example.org'] }

describe('threadEligibility (every combination that must refuse)', () => {
  it('passes only the all-clear case', () => {
    expect(threadEligibility([m()], tri(), rec)).toEqual({ eligible: true })
  })
  it.each([
    ['no triage record', undefined, 'no_triage'],
    ['needs a reply', tri({ needsReply: true }), 'needs_reply'],
    ['has a deadline', tri({ dueDate: '2026-11-20T00:00:00.000Z' }), 'deadline'],
    ['waiting on someone', tri({ waitingOn: { address: 'x@example.com' } }), 'waiting_on'],
    ['a person category', tri({ category: 'person' }), 'category'],
    ['a calendar invite', tri({ category: 'calendar' }), 'category'],
    ['category other', tri({ category: 'other' }), 'category'],
  ] as const)('refuses %s', (_n, t, reason) => {
    expect(threadEligibility([m()], t, rec)).toEqual({ eligible: false, reason })
  })
  it('refuses a thread the user wrote in, and one that involves a correspondent', () => {
    expect(threadEligibility([m(), m('owner@example.org', { id: 'm2' })], tri(), rec)).toEqual({ eligible: false, reason: 'you_wrote_in_thread' })
    expect(threadEligibility([m('marta@example.com')], tri(), rec)).toEqual({ eligible: false, reason: 'correspondent' })
    expect(threadEligibility([m('news@lists.example.net', { to: [{ address: 'marta@example.com' }] })], tri(), rec)).toEqual({ eligible: false, reason: 'correspondent' })
  })
  it('the user\'s correction to needs-reply refuses, even if the category is a newsletter', () => {
    expect(threadEligibility([m()], tri({ needsReply: true, userOverridden: true }), rec)).toEqual({ eligible: false, reason: 'needs_reply' })
    expect([...NO_ACTION_CATEGORIES].sort()).toEqual(['newsletter', 'notification', 'promotion', 'receipt'])
  })
})

async function setup(triageFor: (c: LabelledCorpus, tid: string) => Triage | undefined) {
  const corpus = generateLabelledCorpus({ seed: 5 })
  const p = new FakeEmailProvider(corpus.mailbox)
  const cache = new InMemoryEmailCache()
  await syncAccount(p, cache)
  const folders = await cache.getFolders(p.account.id)
  const triage = new InMemoryTriageStore()
  for (const t of corpus.mailbox.threads) { const r = triageFor(corpus, t.id); if (r) await triage.put(r) }
  const gate = createRuleGate(cache, { triage, correspondents: await correspondentsOf(cache, p.account), ownAddresses: [p.account.address] })
  const action: ActionContext = { cache, provider: p, log: new EmailActionLog(), now: () => NOW, turn: new TurnCeiling() }
  const d: OrganiseDeps = { account: p.account, action, session: new OrganiseSession(), snoozes: new SnoozeStore() }
  const projects = folders.find((f) => f.kind === 'custom')!
  return { corpus, p, cache, folders, triage, gate, d, projects }
}
/** A triage that gets every label right (what a good model would do). */
const oracle = (c: LabelledCorpus, tid: string): Triage => tri({ threadId: tid, needsReply: c.verdicts[tid] === 'needs_response', category: c.verdicts[tid] === 'needs_response' ? 'person' : 'newsletter' })
/** The same, except it wrongly files the tracker notification as a plain notification with no reply needed. */
const sloppy = (c: LabelledCorpus, tid: string): Triage => {
  const first = threadMessages(c.mailbox, tid)[0]!
  return first.from.address === 'notifications@tracker.example.org' ? tri({ threadId: tid, category: 'notification' }) : oracle(c, tid)
}

describe('the gate against the labelled corpus', () => {
  it('ungated bulk-sender rules leak (control); gated, nothing that needs a response is touched', async () => {
    const s = await setup(oracle)
    const rules = ungatedBulkSenderRules(s.corpus.mailbox.messages)
    expect(ruleLeaks(rules, s.corpus).length).toBeGreaterThanOrEqual(3)
    const store = new RuleStore()
    for (const match of rules) store.put({ id: store.nextId(), accountId: s.p.account.id, match, action: { type: 'label', target: s.projects.id }, evidenceMessageIds: [], state: 'active', origin: 'learned', createdAt: NOW })
    const inbox = (await s.cache.queryMessages({ folderId: 'fld-inbox' }, { offset: 0, limit: 100_000 })).items
    const res = await matchActiveRules(inbox, { account: s.p.account, gate: s.gate, folders: s.folders, store })
    const matched = [...res.byRule.values()].flat()
    expect(matched.length).toBeGreaterThan(0)
    for (const x of matched) expect(s.corpus.verdicts[x.threadId]).toBe('no_action')
    expect(res.blocked.length).toBeGreaterThanOrEqual(3)
    // Every match that needed a response was refused (refusing a little more than that, like a correspondent's thank-you, is the safe side).
    const blockedThreads = new Set(res.blocked.map((b) => inbox.find((i) => i.id === b.messageId)!.threadId))
    for (const t of rules.length ? ruleLeaks(rules, s.corpus) : []) expect(blockedThreads.has(t)).toBe(true)
  })
  it('defence in depth: with a sloppy triage the correspondent check still stops two of the three traps', async () => {
    const s = await setup(sloppy)
    const inbox = (await s.cache.queryMessages({ folderId: 'fld-inbox' }, { offset: 0, limit: 100_000 })).items
    const ok = await eligibleMessageIds(inbox, s.gate)
    const leaked = s.corpus.traps.filter((t) => s.corpus.verdicts[t] === 'needs_response' && threadMessages(s.corpus.mailbox, t).some((x) => ok.has(x.id)))
    expect(leaked).toHaveLength(1)
    expect(threadMessages(s.corpus.mailbox, leaked[0]!)[0]!.from.address).toBe('notifications@tracker.example.org')
  })
  it('an unreviewed mailbox is fully blocked (fail closed)', async () => {
    const s = await setup(() => undefined)
    const inbox = (await s.cache.queryMessages({ folderId: 'fld-inbox' }, { offset: 0, limit: 100_000 })).items
    expect((await eligibleMessageIds(inbox, s.gate)).size).toBe(0)
  })
})

describe('proposing and applying through the gate', () => {
  it('learnExactRules proposes no rule for a sender that also sends mail needing action', async () => {
    const s = await setup(oracle)
    const filed: Message[] = [1, 2, 3, 4].map((i) => m('billing@acme.example', { id: `a${i}`, threadId: `ta${i}`, folderIds: [s.projects.id] }))
    const ok = new Set(filed.map((x) => x.id))
    const withGate = learnExactRules({ id: 'a' }, s.folders, filed, new RuleStore(), { eligible: (x) => ok.has(x.id) }, () => NOW)
    expect(withGate.some((r) => r.match.kind === 'sender')).toBe(true)
    ok.delete('a3')
    const blocked = learnExactRules({ id: 'a' }, s.folders, filed, new RuleStore(), { eligible: (x) => ok.has(x.id) }, () => NOW)
    expect(blocked.some((r) => r.match.kind === 'sender')).toBe(false)
  })
  it('applyRulesToNewMail files eligible mail and reports what the gate blocked', async () => {
    const s = await setup(oracle)
    const store = new RuleStore()
    const bulk = ungatedBulkSenderRules(s.corpus.mailbox.messages)
    for (const match of bulk) { const r = { id: store.nextId(), accountId: s.p.account.id, match, action: { type: 'label' as const, target: s.projects.id }, evidenceMessageIds: [], state: 'proposed' as const, origin: 'learned' as const, createdAt: NOW }; store.put(r); approveRule(store, r.id) }
    const inbox = (await s.cache.queryMessages({ folderId: 'fld-inbox' }, { offset: 0, limit: 100_000 })).items
    const res = await applyRulesToNewMail(inbox, { account: s.p.account, gate: s.gate, folders: s.folders, store, organise: s.d })
    expect(res.blocked.length).toBeGreaterThanOrEqual(3)
    for (const b of res.blocked) expect(s.cache.getMessage(b.messageId)).resolves.toMatchObject({ folderIds: ['fld-inbox'] })
  })
})

describe('after filing: leaks pause the rule', () => {
  it('a later reply pulls the thread back, undoes the filing, records the leak and pauses the rule', async () => {
    const s = await setup(oracle)
    const store = new RuleStore()
    const target = threadMessages(s.corpus.mailbox, s.corpus.mailbox.threads.find((t) => s.corpus.verdicts[t.id] === 'no_action' && threadMessages(s.corpus.mailbox, t.id)[0]!.headers['list-unsubscribe'] && !threadMessages(s.corpus.mailbox, t.id)[0]!.from.address.includes('harbourlight'))!.id)[0]!
    const rule = { id: store.nextId(), accountId: s.p.account.id, match: { kind: 'sender' as const, address: target.from.address }, action: { type: 'label' as const, target: s.projects.id }, evidenceMessageIds: [], state: 'proposed' as const, origin: 'learned' as const, createdAt: NOW }
    store.put(rule); approveRule(store, rule.id)
    const res = await applyRulesToNewMail([target], { account: s.p.account, gate: s.gate, folders: s.folders, store, organise: s.d })
    expect(res.applied).toHaveLength(1)
    expect((await s.cache.getMessage(target.id))!.folderIds).toContain(s.projects.id)
    // The user now writes to the sender: the thread is no longer mail that needs nothing.
    s.p.deliver({ from: { address: target.from.address }, subject: 'question', textBody: 'Can you confirm?', threadId: target.threadId })
    await s.triage.put(tri({ threadId: target.threadId, needsReply: true, category: 'person' }))
    const found = await rescanFiled(store, s.gate, s.d.action, () => NOW)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ reason: 'needs_reply', undone: true, paused: true })
    expect((await s.cache.getMessage(target.id))!.folderIds).not.toContain(s.projects.id)
    expect(store.get(rule.id)!.state).toBe('paused')
    expect(store.leaksFor(rule.id)).toHaveLength(1)
    // A paused rule matches nothing.
    expect((await matchActiveRules([target], { account: s.p.account, gate: s.gate, folders: s.folders, store })).byRule.size).toBe(0)
  })
  it('the user marking a filed message as needing action pauses the rule at once', async () => {
    const s = await setup(oracle)
    const store = new RuleStore()
    const rule = { id: store.nextId(), accountId: 'a', match: { kind: 'sender' as const, address: 'x@example.net' }, action: { type: 'label' as const, target: 'f' }, evidenceMessageIds: [], state: 'proposed' as const, origin: 'learned' as const, createdAt: NOW }
    store.put(rule); approveRule(store, rule.id)
    store.recordFiling({ messageId: 'mm', ruleId: rule.id, actionId: 'act', folderIds: ['f'] })
    expect(markFiledNeedsAction(store, 'mm', () => NOW)).toMatchObject({ paused: true })
    expect(store.get(rule.id)!.state).toBe('paused')
    expect(store.leaksFor(rule.id)[0]!.reason).toBe('user_marked')
    expect(markFiledNeedsAction(store, 'unknown')).toBeUndefined()
    void s
  })
})
