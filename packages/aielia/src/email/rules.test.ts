import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import { EmailActionLog, TurnCeiling, type ActionContext } from './action-log.js'
import { OrganiseSession, SnoozeStore, confirmPending, type OrganiseDeps } from './organise-tools.js'
import {
  RuleStore, RULE_JUDGE_SYSTEM_PROMPT, RULE_PROPOSE_SYSTEM_PROMPT, applyRulesToNewMail, approveRule, describeRule, exactMatch, learnExactRules,
  matchActiveRules, pauseRule, previewRuleOnExisting, proposeDescribedRules, proposeRules, proposeUserStatedRule, recordUserMove, rejectRule,
  type RuleModel,
} from './rules.js'
import type { Folder, Message } from './model.js'

const NOW = '2026-11-13T00:00:00.000Z'
async function setup(): Promise<{ d: OrganiseDeps; p: FakeEmailProvider; c: InMemoryEmailCache; folders: Folder[]; inbox: Message[]; projects: Folder }> {
  const p = new FakeEmailProvider()
  const c = new InMemoryEmailCache()
  await syncAccount(p, c)
  const action: ActionContext = { cache: c, provider: p, log: new EmailActionLog(), now: () => NOW, turn: new TurnCeiling() }
  const folders = await c.getFolders(p.account.id)
  const inbox = (await c.queryMessages({ folderId: 'fld-inbox' }, { offset: 0, limit: 100_000 })).items
  const projects = folders.find((f) => f.kind === 'custom')!
  return { d: { account: p.account, action, session: new OrganiseSession(), snoozes: new SnoozeStore() }, p, c, folders, inbox, projects }
}
const msg = (id: string, from: string, folderIds: string[], extra: Partial<Message> = {}): Message => ({
  id, accountId: 'acct', threadId: `t-${id}`, providerId: id, folderIds, from: { address: from }, to: [], cc: [], subject: `Subject ${id}`, date: NOW,
  headers: {}, textBody: `Body of ${id}`, attachments: [], flags: { read: false, starred: false, draft: false, sent: false }, ...extra,
}) as Message
const countingModel = (answer: (user: string) => string): { model: RuleModel; calls: Array<{ system: string; user: string }> } => {
  const calls: Array<{ system: string; user: string }> = []
  return { calls, model: async (system, user) => { calls.push({ system, user }); return answer(user) } }
}
const filedSample = (folderId: string): Message[] => [
  ...[1, 2, 3, 4].map((i) => msg(`a${i}`, 'billing@acme.example', [folderId])),
  msg('x1', 'other@acme.example', [folderId]),
  ...[1, 2, 3].map((i) => msg(`n${i}`, 'news@lists.example', [folderId], { headers: { 'List-Id': '<weekly.example>' } })),
  msg('r1', 'rare@one.example', [folderId]),
]

describe('learning from the folder structure', () => {
  it('proposes exact rules with evidence and a plain description; stores nothing as active', async () => {
    const { folders, projects } = await setup()
    const store = new RuleStore()
    const sample = filedSample(projects.id)
    const rules = learnExactRules({ id: 'acct' }, folders, sample, store, {}, () => NOW)
    const kinds = rules.map((r) => r.match.kind).sort()
    expect(kinds).toContain('list_header')
    expect(kinds).toContain('sender')
    expect(rules.every((r) => r.state === 'proposed' && r.origin === 'learned')).toBe(true)
    expect(rules.every((r) => r.action.type === 'move' && r.action.target === projects.id)).toBe(true)
    const sender = rules.find((r) => r.match.kind === 'sender')!
    expect(sender.evidenceMessageIds).toEqual(['a1', 'a2', 'a3', 'a4'])
    const words = describeRule(sender, folders, sample)
    expect(words.text).toContain('billing@acme.example')
    expect(words.text).toContain(projects.name)
    expect(words.examples).toContain('Subject a1')
    expect(store.list()).toEqual([]) // proposals only until proposeRules
  })
  it('skips a pattern that also appears outside the folder, or with too few examples', async () => {
    const { folders, projects } = await setup()
    const sample = [...filedSample(projects.id), ...[1, 2, 3, 4, 5, 6].map((i) => msg(`o${i}`, 'billing@acme.example', ['fld-inbox']))]
    const rules = learnExactRules({ id: 'acct' }, folders, sample, new RuleStore(), {}, () => NOW)
    expect(rules.find((r) => r.match.kind === 'sender' && r.match.address === 'billing@acme.example')).toBeUndefined()
    expect(rules.find((r) => r.match.kind === 'sender' && r.match.address === 'rare@one.example')).toBeUndefined()
  })
  it('does not re-propose a rejected rule or one that exists', async () => {
    const { folders, projects } = await setup()
    const store = new RuleStore()
    const sample = filedSample(projects.id)
    const first = proposeRules(store, learnExactRules({ id: 'acct' }, folders, sample, store, {}, () => NOW))
    expect(first.length).toBeGreaterThan(0)
    expect(learnExactRules({ id: 'acct' }, folders, sample, store, {}, () => NOW)).toEqual([])
    rejectRule(store, first[0]!.id)
    const again = learnExactRules({ id: 'acct' }, folders, sample, store, {}, () => NOW)
    expect(again.map((r) => r.match)).not.toContainEqual(first[0]!.match)
  })
})

describe('described rules from the model', () => {
  const acct = { id: 'acct', aieliaMayRead: true, excludedFolders: [] as string[], excludedSenders: [] as string[] }
  it('proposes only for folders it was shown, one per folder, and never active', async () => {
    const { folders, projects } = await setup()
    const store = new RuleStore()
    const { model, calls } = countingModel(() => JSON.stringify({ rules: [
      { folderId: projects.id, description: 'is about the office move' },
      { folderId: projects.id, description: 'second for same folder' },
      { folderId: 'made-up', description: 'not shown' },
    ] }))
    const rules = await proposeDescribedRules(filedSample(projects.id), { account: acct, folders, model, store, now: () => NOW })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.system).toBe(RULE_PROPOSE_SYSTEM_PROMPT)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ state: 'proposed', match: { kind: 'description', text: 'is about the office move' } })
  })
  it('a failing or garbled call proposes nothing', async () => {
    const { folders, projects } = await setup()
    const s = filedSample(projects.id)
    const bad = await proposeDescribedRules(s, { account: acct, folders, store: new RuleStore(), model: async () => { throw new Error('down') } })
    const junk = await proposeDescribedRules(s, { account: acct, folders, store: new RuleStore(), model: async () => 'not json' })
    expect(bad).toEqual([])
    expect(junk).toEqual([])
  })
  it('sends nothing for an account that may not be read', async () => {
    const { folders, projects } = await setup()
    const { model, calls } = countingModel(() => '{"rules":[]}')
    await proposeDescribedRules(filedSample(projects.id), { account: { ...acct, aieliaMayRead: false }, folders, model, store: new RuleStore() })
    expect(calls).toHaveLength(0)
  })
})

describe('no rule acts before approval', () => {
  it('proposed and paused rules match nothing and change nothing', async () => {
    const { d, p, c, folders, inbox, projects } = await setup()
    const store = new RuleStore()
    const from = inbox[0]!.from.address
    const rule = proposeUserStatedRule(store, p.account.id, { kind: 'sender', address: from }, { type: 'move', target: projects.id })!
    const deps = { account: p.account, folders, store, organise: d }
    const before = (await c.getMessage(inbox[0]!.id))!.folderIds
    const r1 = await applyRulesToNewMail(inbox, deps)
    expect(r1.applied).toEqual([])
    expect(r1.pending).toEqual([])
    expect((await c.getMessage(inbox[0]!.id))!.folderIds).toEqual(before)
    approveRule(store, rule.id)
    pauseRule(store, rule.id)
    expect((await matchActiveRules(inbox, deps)).byRule.size).toBe(0)
    expect(d.action.log.list()).toHaveLength(0)
  })
  it('a model cannot approve: an approved rule needs approveRule', async () => {
    const store = new RuleStore()
    const r = proposeUserStatedRule(store, 'acct', { kind: 'domain', domain: 'x.example' }, { type: 'archive' })!
    expect(store.get(r.id)!.state).toBe('proposed')
    expect(proposeRules(store, [{ ...r, id: 'forged', state: 'active' }])).toEqual([]) // only proposals are accepted
    expect(store.get('forged')).toBeUndefined()
  })
})

describe('exact rules make no model call', () => {
  it('sender, domain and list header match by fields; an approved rule files one message and logs it', async () => {
    const { d, p, c, folders, inbox, projects } = await setup()
    const store = new RuleStore()
    const { model, calls } = countingModel(() => '{"matches":[]}')
    const target = inbox[0]!
    const only = inbox.filter((m) => m.from.address === target.from.address)
    const rule = proposeUserStatedRule(store, p.account.id, { kind: 'sender', address: target.from.address.toUpperCase() }, { type: 'move', target: projects.id })!
    approveRule(store, rule.id)
    expect(exactMatch(rule.match, target)).toBe(true)
    const res = await applyRulesToNewMail(only.slice(0, 1), { account: p.account, folders, store, model, organise: d })
    expect(calls).toHaveLength(0)
    expect(res.modelCalls).toBe(0)
    expect(res.applied).toHaveLength(1)
    expect((await c.getMessage(target.id))!.folderIds).toEqual([projects.id])
    expect(d.action.log.list()).toHaveLength(1)
    expect(store.filingFor(target.id)?.ruleId).toBe(rule.id)
  })
  it('list header and domain kinds are exact', () => {
    const m = msg('m', 'a@b.example', ['x'], { headers: { 'list-id': '<Weekly.Example>' } })
    expect(exactMatch({ kind: 'list_header', value: '<weekly.example>' }, m)).toBe(true)
    expect(exactMatch({ kind: 'domain', domain: 'B.example' }, m)).toBe(true)
    expect(exactMatch({ kind: 'domain', domain: 'c.example' }, m)).toBe(false)
    expect(exactMatch({ kind: 'description', text: 'anything' }, m)).toBe(false)
  })
})

describe('described matches use the model', () => {
  it('one call for all described rules; only shown ids and known rules count', async () => {
    const { d, p, c, folders, inbox, projects } = await setup()
    const store = new RuleStore()
    const rule = proposeUserStatedRule(store, p.account.id, { kind: 'description', text: 'is about the office move' }, { type: 'move', target: projects.id })!
    approveRule(store, rule.id)
    const [a, b] = inbox
    const { model, calls } = countingModel(() => JSON.stringify({ matches: [
      { messageId: a!.id, ruleId: rule.id }, { messageId: 'invented', ruleId: rule.id }, { messageId: b!.id, ruleId: 'invented' },
    ] }))
    const res = await applyRulesToNewMail([a!, b!], { account: p.account, folders, store, model, organise: d })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.system).toBe(RULE_JUDGE_SYSTEM_PROMPT)
    expect(res.applied.flatMap((x) => x.messageIds)).toEqual([a!.id])
    expect((await c.getMessage(b!.id))!.folderIds).not.toEqual([projects.id])
  })
  it('without a model, or when it fails, a described rule files nothing', async () => {
    const { d, p, folders, inbox, projects } = await setup()
    const store = new RuleStore()
    approveRule(store, proposeUserStatedRule(store, p.account.id, { kind: 'description', text: 'anything' }, { type: 'move', target: projects.id })!.id)
    const none = await applyRulesToNewMail(inbox.slice(0, 2), { account: p.account, folders, store, organise: d })
    const boom = await applyRulesToNewMail(inbox.slice(0, 2), { account: p.account, folders, store, model: async () => { throw new Error('x') }, organise: d })
    expect(none.applied).toEqual([])
    expect(boom.applied).toEqual([])
    expect(d.action.log.list()).toHaveLength(0)
  })
})

describe('a rule on existing mail goes through the preview', () => {
  it('previews, changes nothing until confirmPending, then undo restores', async () => {
    const { d, p, c, folders, inbox, projects } = await setup()
    const store = new RuleStore()
    const domain = inbox[0]!.from.address.split('@')[1]!
    const rule = proposeUserStatedRule(store, p.account.id, { kind: 'domain', domain }, { type: 'move', target: projects.id })!
    expect(await previewRuleOnExisting(rule.id, inbox, { account: p.account, folders, store, organise: d })).toBeUndefined() // not approved
    approveRule(store, rule.id)
    const pending = await previewRuleOnExisting(rule.id, inbox, { account: p.account, folders, store, organise: d })
    expect(pending?.reason).toBe('bulk')
    expect(pending!.messageIds.length).toBeGreaterThan(0)
    expect(d.action.log.list()).toHaveLength(0)
    const before = (await c.getMessage(pending!.messageIds[0]!))!.folderIds
    expect(before).not.toEqual([projects.id])
    const done = await confirmPending(d, pending!.id)
    expect(done.status).toBe('applied')
    expect((await c.getMessage(pending!.messageIds[0]!))!.folderIds).toEqual([projects.id])
  })
})

describe('the correction path', () => {
  it('a user move of filed mail is evidence against the rule; two pause it; the user\'s own filing is not counted', async () => {
    const { d, p, c, folders, inbox, projects } = await setup()
    const store = new RuleStore()
    const rule = proposeUserStatedRule(store, p.account.id, { kind: 'sender', address: 'ignored@x.example' }, { type: 'move', target: projects.id })!
    approveRule(store, rule.id)
    const [a, b, other] = inbox
    // Pretend the rule filed a and b (a real filing is exercised in the exact-rule test).
    await p.move([a!.id, b!.id], projects.id)
    await syncAccount(p, c)
    for (const m of [a!, b!]) store.recordFiling({ messageId: m.id, ruleId: rule.id, actionId: 'x', folderIds: [projects.id] })
    expect(await recordUserMove(store, { cache: c }, a!.id, () => NOW)).toBeUndefined() // still where the rule put it
    expect(await recordUserMove(store, { cache: c }, other!.id, () => NOW)).toBeUndefined() // never filed by a rule

    await p.move([a!.id], 'fld-archive')
    await syncAccount(p, c)
    const one = await recordUserMove(store, { cache: c }, a!.id, () => NOW)
    expect(one).toEqual({ ruleId: rule.id, corrections: 1, paused: false })
    expect(store.get(rule.id)!.state).toBe('active')
    expect(await recordUserMove(store, { cache: c }, a!.id, () => NOW)).toBeUndefined() // counted once

    await p.move([b!.id], 'fld-archive')
    await syncAccount(p, c)
    const two = await recordUserMove(store, { cache: c }, b!.id, () => NOW)
    expect(two).toEqual({ ruleId: rule.id, corrections: 2, paused: true })
    expect(store.get(rule.id)!.state).toBe('paused')
    expect((await matchActiveRules(inbox, { account: p.account, folders, store })).byRule.size).toBe(0)
    void d
  })
})
