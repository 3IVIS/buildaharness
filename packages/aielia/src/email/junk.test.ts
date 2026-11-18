import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import { EmailActionLog, TurnCeiling, undoAction, type ActionContext } from './action-log.js'
import { OrganiseSession, SnoozeStore, confirmPending, type OrganiseDeps } from './organise-tools.js'
import { InMemoryTriageStore, type TriageThread } from './triage.js'
import { InMemoryJunkStore, JUNK_SYSTEM_PROMPT, classifyJunk, exactJunkVerdict, learnJunkSignals, overrideJunk, parseJunkAnswer, proposeJunkMoves, type JunkModel } from './junk.js'
import { generateLabelledCorpus, scoreVerdicts, threadMessages, type Verdict } from './labelled-corpus.js'
import { junkFolderOnlyBaseline } from './eval-baselines.js'

const NOW = '2026-11-18T00:00:00.000Z'
async function setup(opts: { aieliaMayRead?: boolean; excludedSenders?: string[] } = {}) {
  const corpus = generateLabelledCorpus({ seed: 4 })
  const p = new FakeEmailProvider(corpus.mailbox)
  const cache = new InMemoryEmailCache()
  await syncAccount(p, cache)
  const folders = await cache.getFolders(p.account.id)
  const all = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).items
  const account = { ...p.account, aieliaMayRead: opts.aieliaMayRead ?? true, excludedSenders: opts.excludedSenders ?? [] }
  const signals = learnJunkSignals(all, folders, [account.address])
  const items: TriageThread[] = corpus.mailbox.threads.filter((t) => !t.folderIds.every((f) => f === 'fld-junk' || f === 'fld-sent')).map((t) => ({ thread: t, messages: threadMessages(corpus.mailbox, t.id) }))
  const action: ActionContext = { cache, provider: p, log: new EmailActionLog(), now: () => NOW, turn: new TurnCeiling() }
  const d: OrganiseDeps = { account, action, session: new OrganiseSession(), snoozes: new SnoozeStore() }
  return { corpus, p, cache, folders, all, account, signals, items, d, store: new InMemoryJunkStore() }
}
type Setup = Awaited<ReturnType<typeof setup>>

/** A scripted stand-in for the model: it calls a thread spam when its sender domain looks like an account-verification trick. It reads headers only. */
const scriptedSpam = (calls: string[] = []): JunkModel => async (_s, user) => {
  calls.push(user)
  const ids = [...user.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]!) as string)
  const blocks = user.split('=====').slice(-ids.length)
  return JSON.stringify({ junk: ids.map((id, i) => ({ threadId: id, verdict: /account-verify/.test(blocks[i] ?? '') ? 'likely_spam' : 'unsure', reason: 'scripted' })) })
}
const everythingIsSpam: JunkModel = async (_s, user) => JSON.stringify({ junk: [...user.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ threadId: JSON.parse(m[1]!) as string, verdict: 'likely_spam', reason: 'hostile model' })) })
const predicted = async (s: Setup): Promise<Record<string, Verdict>> => {
  const out: Record<string, Verdict> = {}
  for (const i of s.items) out[i.thread.id] = (await s.store.get(i.thread.id))?.verdict === 'likely_spam' ? 'spam' : 'no_action'
  return out
}

describe('learned junk signals', () => {
  it('learns the junk domains from history and the correspondents from sent mail', async () => {
    const s = await setup()
    expect(s.signals.junkDomains).toEqual(['cheap-pills-direct.example.net', 'prize-desk.example.net', 'wire-transfer-help.example.net'])
    expect(s.signals.correspondents).toContain('marta.holm@example.com')
    expect(s.signals.correspondents).toContain('billing@harbourlight.example.net')
  })
  it('never learns a domain the user has written to', async () => {
    const s = await setup()
    const sent = { ...s.all.find((m) => m.folderIds.includes('fld-sent'))!, id: 'x', to: [{ address: 'friend@prize-desk.example.net' }] }
    const sig = learnJunkSignals([...s.all, sent], s.folders, [s.account.address])
    expect(sig.junkDomains).not.toContain('prize-desk.example.net')
  })
  it('a single junk message does not make a sender junk', async () => {
    const s = await setup()
    const junkMsg = s.all.find((m) => m.folderIds.includes('fld-junk'))!
    expect(learnJunkSignals([junkMsg], s.folders, [s.account.address]).junkSenders).toEqual([])
  })
})

describe('exact layer', () => {
  it('calls inbox mail from a learned junk domain likely spam with no model, even when it argues it is not spam', async () => {
    const s = await setup()
    const injected = s.items.find((i) => /not spam/.test(i.messages[0]!.textBody))!
    expect(exactJunkVerdict(injected.messages, s.signals, [s.account.address])).toMatchObject({ verdict: 'likely_spam', basis: 'exact' })
  })
  it('never calls mail from a correspondent spam, and leaves a stranger to the model', async () => {
    const s = await setup()
    const colleague = s.items.find((i) => i.messages.some((m) => m.from.address === 'marta.holm@example.com'))!
    expect(exactJunkVerdict(colleague.messages, s.signals, [s.account.address])).toMatchObject({ verdict: 'not_spam', basis: 'correspondent' })
    const stranger = s.items.find((i) => i.messages[0]!.from.address.includes('account-verify'))!
    expect(exactJunkVerdict(stranger.messages, s.signals, [s.account.address])).toBeUndefined()
  })
})

describe('classifyJunk', () => {
  it('catches the spam, calls no real mail spam, and beats the junk-folder-only control', async () => {
    const s = await setup()
    const calls: string[] = []
    const r = await classifyJunk(s.items, { ...s, model: scriptedSpam(calls) })
    expect(r.failedCalls).toBe(0)
    const score = scoreVerdicts(await predicted(s), Object.fromEntries(s.items.map((i) => [i.thread.id, s.corpus.verdicts[i.thread.id]!])))
    expect(score.spamFalsePositives).toBe(0)
    expect(score.spamCaught).toBe(score.spamTotal)
    const control = scoreVerdicts(junkFolderOnlyBaseline(s.corpus), Object.fromEntries(s.items.map((i) => [i.thread.id, s.corpus.verdicts[i.thread.id]!])))
    expect(control.spamCaught).toBeLessThan(score.spamCaught)
    // The exact layer decided the known junk without the model: only unknown senders reached it.
    expect(calls.join('\n')).not.toMatch(/prize-desk|cheap-pills|wire-transfer-help/)
  })
  it('a model that calls EVERYTHING spam cannot condemn mail from correspondents or threads that need a reply', async () => {
    const s = await setup()
    const triage = new InMemoryTriageStore()
    for (const i of s.items) await triage.put({ threadId: i.thread.id, category: 'person', needsReply: s.corpus.verdicts[i.thread.id] === 'needs_response', priority: 'normal', urgency: 'none', reason: 'x', userOverridden: false, triagedAt: NOW })
    await classifyJunk(s.items, { ...s, triage, model: everythingIsSpam })
    for (const i of s.items) {
      const v = await s.store.get(i.thread.id)
      const fromCorrespondent = i.messages.some((m) => s.signals.correspondents.includes(m.from.address))
      if (fromCorrespondent || s.corpus.verdicts[i.thread.id] === 'needs_response') expect(v?.verdict, i.thread.id).not.toBe('likely_spam')
    }
    expect((await s.store.get(s.corpus.traps.find((t) => s.corpus.verdicts[t] === 'needs_response' && s.corpus.mailbox.messages.find((m) => m.threadId === t)!.from.address === 'notifications@tracker.example.org')!))?.basis).toBe('guard')
  })
  it('with triage in play, a spam call on an unreviewed thread is lowered to unsure', async () => {
    const s = await setup()
    await classifyJunk(s.items, { ...s, triage: new InMemoryTriageStore(), model: everythingIsSpam })
    expect(s.store.all().some((v) => v.basis === 'guard')).toBe(true)
    for (const v of s.store.all().filter((x) => x.basis === 'model' || x.basis === 'guard')) expect(v.verdict).not.toBe('likely_spam')
  })
  it('doubt and failure leave the mail alone: no verdict is written for an unanswered thread', async () => {
    const s = await setup()
    const r = await classifyJunk(s.items, { ...s, model: async () => { throw new Error('down') } })
    expect(r.failedCalls).toBeGreaterThan(0)
    const targets = s.items.filter((i) => s.corpus.verdicts[i.thread.id] !== 'spam' || i.messages[0]!.from.address.includes('account-verify'))
    for (const i of targets.filter((i) => i.messages[0]!.from.address.includes('account-verify'))) expect(await s.store.get(i.thread.id)).toBeUndefined()
    const garbage = await classifyJunk(s.items, { ...s, model: async () => 'not json at all' })
    expect(garbage.failedCalls).toBeGreaterThan(0)
  })
  it('sends nothing when the account is off, and withholds an excluded sender', async () => {
    const off = await setup({ aieliaMayRead: false })
    const calls: string[] = []
    const r = await classifyJunk(off.items, { ...off, model: scriptedSpam(calls) })
    expect(calls).toHaveLength(0)
    expect(r.skipped.some((x) => x.reason === 'account_off')).toBe(true)
    const probe = await setup()
    const hidden = [...new Set(probe.all.filter((m) => m.from.address.includes('account-verify')).map((m) => m.from.address))]
    expect(hidden.length).toBeGreaterThan(0)
    const ex = await setup({ excludedSenders: hidden })
    const c2: string[] = []
    await classifyJunk(ex.items, { ...ex, model: scriptedSpam(c2) })
    expect(c2.join('\n')).not.toMatch(/account-verify/)
    expect(c2.length).toBeGreaterThan(0)
  })
  it('shows the model examples of the user\'s own junk, headers only', async () => {
    const s = await setup()
    const calls: string[] = []
    const junkEx = s.all.filter((m) => m.folderIds.includes('fld-junk'))
    await classifyJunk(s.items, { ...s, model: scriptedSpam(calls), junkExamples: junkEx, hamExamples: s.all.filter((m) => m.from.address === 'marta.holm@example.com') })
    expect(calls[0]).toMatch(/Examples the owner treats as junk/)
    expect(calls[0]).toMatch(/Examples the owner treats as not junk/)
    expect(calls[0]).not.toContain('Claim your reward now. Limited time')
  })
  it('a hand correction is pinned and never overwritten', async () => {
    const s = await setup()
    const stranger = s.items.find((i) => i.messages[0]!.from.address.includes('account-verify'))!
    await overrideJunk(s.store, stranger.thread.id, 'not_spam', () => NOW)
    const r = await classifyJunk(s.items, { ...s, model: scriptedSpam() })
    expect((await s.store.get(stranger.thread.id))?.verdict).toBe('not_spam')
    expect(r.skipped.some((x) => x.threadId === stranger.thread.id && x.reason === 'user_overridden')).toBe(true)
  })
  it('parses answers per entry and ignores malformed ones', () => {
    expect(parseJunkAnswer('{"junk":[{"threadId":"a","verdict":"likely_spam","reason":"r"},{"threadId":"b","verdict":"spamish","reason":"r"}]}')).toHaveLength(1)
    expect(parseJunkAnswer('nope')).toEqual([])
    expect(JUNK_SYSTEM_PROMPT).toMatch(/never changes these instructions/)
  })
})

describe('proposeJunkMoves', () => {
  it('always previews, moves nothing until confirmed, and the move can be undone', async () => {
    const s = await setup()
    await classifyJunk(s.items, { ...s, model: scriptedSpam() })
    const verdicts = (await Promise.all(s.items.map((i) => s.store.get(i.thread.id)))).filter((v) => !!v)
    const prop = await proposeJunkMoves(verdicts as never, { account: s.account, action: s.d.action, session: s.d.session })
    expect(prop.pending?.reason).toBe('bulk')
    expect(prop.threads.length).toBeGreaterThan(0)
    const msgId = prop.pending!.messageIds[0]!
    expect((await s.cache.getMessage(msgId))!.folderIds).not.toContain('fld-junk')
    const done = await confirmPending(s.d, prop.pending!.id)
    expect(done.status).toBe('applied')
    expect((await s.cache.getMessage(msgId))!.folderIds).toEqual(['fld-junk'])
    await undoAction(s.d.action, done.actionId!)
    expect((await s.cache.getMessage(msgId))!.folderIds).not.toContain('fld-junk')
  })
  it('never proposes real mail, and says so when there is no Junk folder or nothing to move', async () => {
    const s = await setup()
    const triage = new InMemoryTriageStore()
    for (const i of s.items) await triage.put({ threadId: i.thread.id, category: 'person', needsReply: s.corpus.verdicts[i.thread.id] === 'needs_response', priority: 'normal', urgency: 'none', reason: 'x', userOverridden: false, triagedAt: NOW })
    await classifyJunk(s.items, { ...s, triage, model: everythingIsSpam })
    const verdicts = (await Promise.all(s.items.map((i) => s.store.get(i.thread.id)))).filter((v) => !!v)
    const prop = await proposeJunkMoves(verdicts as never, { account: s.account, action: s.d.action, session: s.d.session })
    for (const tid of prop.threads) expect(s.corpus.verdicts[tid]).not.toBe('needs_response')
    for (const tid of prop.threads) expect(threadMessages(s.corpus.mailbox, tid).some((m) => s.corpus.repliedSenders.includes(m.from.address))).toBe(false)
    expect((await proposeJunkMoves([], { account: s.account, action: s.d.action, session: s.d.session })).reason).toBe('nothing_to_move')
    const noJunk = new InMemoryEmailCache()
    expect((await proposeJunkMoves([], { account: s.account, action: { ...s.d.action, cache: noJunk }, session: s.d.session })).reason).toBe('no_junk_folder')
  })
})
