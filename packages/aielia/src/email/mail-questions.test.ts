import { describe, it, expect } from 'vitest'
import { OfflineEmailSession } from './offline-session.js'
import { generateLabelledCorpus } from './labelled-corpus.js'
import { buildQuestionSet } from './mail-question-set.js'
import { MAIL_READ_TOOLS, MAIL_READ_TOOL_NAMES, runMailReadTool } from './mail-tools.js'
import { MAIL_TOOL_CLASSES, evaluateToolPolicy } from '../tool-policy.js'
import { InMemoryEmailCache } from './cache.js'
import { syncAccount } from './sync.js'
import { FakeEmailProvider } from './fake-provider.js'

const NOW = () => '2026-11-02T00:00:00.000Z'
const corpus = generateLabelledCorpus({ seed: 6 })
const session = () => new OfflineEmailSession({ mailbox: corpus.mailbox, now: NOW })
const questions = buildQuestionSet(corpus)

describe('question set', () => {
  it('has about forty questions across every kind, with oracles for the answerable ones', () => {
    expect(questions.length).toBeGreaterThanOrEqual(35)
    expect(new Set(questions.map((q) => q.kind))).toEqual(new Set(['find', 'count', 'status', 'catch_up', 'todo', 'draft', 'ambiguous']))
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length)
  })
  it('the shared tools are enough to answer every question that names an oracle tool', async () => {
    const s = session()
    await s.run(['review'])
    for (const q of questions.filter((x) => x.oracleTool)) {
      const r = await s.runTool(q.oracleTool!.name, q.oracleTool!.args)
      expect(r.ok, `${q.id}: ${r.text.slice(0, 120)}`).toBe(true)
      for (const needle of q.mustContain) expect(r.text, q.id).toContain(needle)
    }
  })
  it('a find question is answered with a citation to the real message', async () => {
    const s = session()
    const q = questions.find((x) => x.id === 'find-1')!
    const r = await s.runTool(q.oracleTool!.name, q.oracleTool!.args)
    expect(r.citations.some((c) => q.mustContain.includes(c.threadId))).toBe(true)
  })
})

describe('mail_count', () => {
  it('counts, groups, filters by date and says what it covered', async () => {
    const s = session()
    const all = await s.runTool('mail_count', {})
    expect(all.text).toMatch(/^\d+ messages\./)
    expect(all.text).toMatch(/synced to this device/)
    const bySender = await s.runTool('mail_count', { groupBy: 'sender', top: 3 })
    expect(bySender.text.split('\n').filter((l) => l.startsWith('  ')).length).toBe(4) // 3 + "…and N more"
    const byMonth = await s.runTool('mail_count', { groupBy: 'month' })
    expect(byMonth.text).toMatch(/2026-1\d: \d+/)
    const none = await s.runTool('mail_count', { after: '2030-01-01T00:00:00.000Z' })
    expect(none.text).toMatch(/^0 messages\./)
    const byDomain = await s.runTool('mail_count', { groupBy: 'domain', from: 'prize-desk' })
    expect(byDomain.text).toMatch(/prize-desk\.example\.net: \d+/)
  })
  it('refuses bad arguments, mentions the window, and never counts excluded mail', async () => {
    const s = session()
    expect((await s.runTool('mail_count', { groupBy: 'colour' })).ok).toBe(false)
    expect((await s.runTool('mail_count', { folder: 'Nowhere' })).ok).toBe(false)
    const mb = new FakeEmailProvider(corpus.mailbox)
    const cache = new InMemoryEmailCache()
    await syncAccount(mb, cache)
    const base = { account: { ...mb.account, aieliaMayRead: true, excludedSenders: [] as string[] }, cache, context: { chips: [] }, windowSince: '2026-10-01T00:00:00.000Z' }
    const open = await runMailReadTool('mail_count', {}, base)
    expect(open.text).toMatch(/from 2026-10-01 on; older mail on the server is not counted/)
    const hidden = await runMailReadTool('mail_count', {}, { ...base, account: { ...base.account, excludedSenders: ['@prize-desk.example.net'] } })
    expect(hidden.withheld).toBeGreaterThan(0)
    expect(hidden.text).toMatch(/not counted: excluded from Aielia/)
    const n = (t: string): number => Number(/^(\d+) messages/.exec(t)![1])
    expect(n(hidden.text) + hidden.withheld).toBe(n(open.text))
    const off = await runMailReadTool('mail_count', { groupBy: 'sender' }, { ...base, account: { ...base.account, aieliaMayRead: false } })
    expect(off.text).toMatch(/^0 messages/)
    expect(off.text).not.toContain('@')
  })
})

describe('mail_summarise by topic', () => {
  it('finds the threads about a topic and summarises only those, wrapped as untrusted', async () => {
    const prompts: string[] = []
    const s = new OfflineEmailSession({ mailbox: corpus.mailbox, now: NOW, summariser: async (_sys, user) => { prompts.push(user); return 'A summary.' } })
    const target = corpus.mailbox.threads.find((t) => t.subject.startsWith('Quick question about the'))!
    const r = await s.runTool('mail_summarise', { topic: target.subject })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('A summary.')
    expect(prompts[0]).toContain('<untrusted_external_content>')
    expect(prompts[0]).toContain(target.subject)
    expect(r.citations.length).toBeGreaterThan(0)
    expect((await s.runTool('mail_summarise', { topic: 'zzz-no-such-topic-qqq' })).ok).toBe(false)
  })
})

describe('mail_catch_up tool', () => {
  it('runs the review, reports counts as plain text and thread details wrapped as data', async () => {
    const s = session()
    const r = await s.runTool('mail_catch_up', { window: 'all' })
    expect(r.ok).toBe(true)
    expect(r.readMail).toBe(true)
    expect(r.text).toMatch(/^\d+ of \d+ threads \(all messages\) need a response/)
    expect(r.text).toContain('<untrusted_external_content>')
    expect(r.citations.length).toBeGreaterThan(0)
    // Counts stay outside the wrapper.
    expect(r.text.split('<untrusted_external_content>')[0]).toMatch(/need a response/)
  })
  it('rejects an unknown window and reports when no runner is wired', async () => {
    expect((await session().runTool('mail_catch_up', { window: '14' })).ok).toBe(false)
    const mb = new FakeEmailProvider(corpus.mailbox), cache = new InMemoryEmailCache()
    await syncAccount(mb, cache)
    const r = await runMailReadTool('mail_catch_up', {}, { account: mb.account, cache, context: { chips: [] } })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/not available here/)
  })
})

describe('the new tools stay read-only', () => {
  it('are all classed read_only, allowed by the gate, and listed with definitions', () => {
    expect(MAIL_READ_TOOLS.map((t) => t.name)).toEqual([...MAIL_READ_TOOL_NAMES])
    for (const n of ['mail_count', 'mail_catch_up']) {
      expect(MAIL_TOOL_CLASSES[n]).toBe('read_only')
      expect(evaluateToolPolicy({ toolName: n, riskHint: 'LOW', origin: 'untrusted_mail' }).decision).toBe('ALLOW')
    }
  })
  it('a hostile message cannot make a read tool do anything but read: the tool set has no outward member', () => {
    for (const t of MAIL_READ_TOOLS) expect(MAIL_TOOL_CLASSES[t.name]).toBe('read_only')
  })
})
