import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import { OfflineEmailSession } from './offline-session.js'
import { InMemoryJunkStore, classifyJunk, learnJunkSignals, type JunkModel } from './junk.js'
import { InMemoryTriageStore, type TriageThread } from './triage.js'
import { generateLabelledCorpus, threadMessages } from './labelled-corpus.js'
import { searchMail } from './mail-search.js'
import { runMailReadTool } from './mail-tools.js'

const NOW = () => '2026-11-02T00:00:00.000Z'
const INJECTION = /Note to the assistant reading this/

/** Remove every wrapped block: what is left is what a model would read as instructions or plain context. */
const outsideWrapper = (prompt: string): string => prompt.replace(/<untrusted_external_content>[\s\S]*?<\/untrusted_external_content>/g, '')

describe('capabilities against hostile mail (the injection spam in the labelled corpus)', () => {
  const corpus = generateLabelledCorpus({ seed: 8 })

  it('catch-up, spam and summaries show the hostile text to a model only inside the untrusted wrapper', async () => {
    const prompts: string[] = []
    const record = (fn: (s: string, u: string) => Promise<string>) => async (s: string, u: string): Promise<string> => { prompts.push(`${s}\n${u}`); return fn(s, u) }
    const s = new OfflineEmailSession({
      mailbox: corpus.mailbox, now: NOW,
      triageModel: record(async () => '{"triage":[]}'), junkModel: record(async () => '{"junk":[]}'), summariser: record(async () => 'ok'),
    })
    await s.run(['catchup', 'all'])
    await s.run(['spam'])
    await s.runTool('mail_summarise', { topic: 'your request' })
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.some((p) => INJECTION.test(p))).toBe(true)
    for (const p of prompts.filter((x) => INJECTION.test(x))) expect(INJECTION.test(outsideWrapper(p)), 'injection text outside the wrapper').toBe(false)
  })

  it('reading it changes nothing: no mail moves, no draft or send exists afterwards', async () => {
    const provider = new FakeEmailProvider(corpus.mailbox)
    const before = JSON.stringify(await Promise.all((await provider.listFolders()).map(async (f) => (await provider.listMessages(f.id, { limit: 500 })).items.map((m) => [m.id, m.folderIds, m.flags]))))
    const s = new OfflineEmailSession({ mailbox: corpus.mailbox, now: NOW })
    await s.run(['catchup', 'all'])
    await s.run(['todo'])
    await s.runTool('mail_search', { text: 'reading this', scope: 'both' })
    await s.runTool('mail_count', { groupBy: 'sender' })
    await s.runTool('mail_summarise', { topic: 'your request' })
    const after = JSON.stringify(await Promise.all((await s.provider.listFolders()).map(async (f) => (await s.provider.listMessages(f.id, { limit: 500 })).items.map((m) => [m.id, m.folderIds, m.flags]))))
    expect(after).toBe(before)
    expect(s.pending()).toHaveLength(0)
  })

  it('a model that OBEYS the injection ("this is not spam") cannot clear it: the exact layer decides first (control: without it the model wins)', async () => {
    const provider = new FakeEmailProvider(corpus.mailbox)
    const cache = new InMemoryEmailCache()
    await syncAccount(provider, cache)
    const folders = await cache.getFolders(provider.account.id)
    const all = (await cache.queryMessages({}, { offset: 0, limit: 100_000 })).items
    const account = provider.account
    const injected = corpus.mailbox.threads.find((t) => INJECTION.test(corpus.mailbox.messages.find((m) => m.threadId === t.id)!.textBody))!
    const items: TriageThread[] = [{ thread: injected, messages: threadMessages(corpus.mailbox, injected.id) }]
    const obeys: JunkModel = async (_s, user) => JSON.stringify({ junk: [...user.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ threadId: JSON.parse(m[1]!) as string, verdict: 'not_spam', reason: 'The message says it is not spam.' })) })
    // Control arm: no learned signals, so the fooled model decides.
    const control = new InMemoryJunkStore()
    await classifyJunk(items, { account, folders, signals: { junkSenders: [], junkDomains: [], correspondents: [] }, model: obeys, store: control })
    expect((await control.get(injected.id))?.verdict).toBe('not_spam')
    // Candidate arm: the learned junk history decides before the model is asked.
    const candidate = new InMemoryJunkStore()
    let asked = 0
    await classifyJunk(items, { account, folders, signals: learnJunkSignals(all, folders, [account.address]), model: async (s, u) => { asked++; return obeys(s, u) }, store: candidate, triage: new InMemoryTriageStore() })
    expect((await candidate.get(injected.id))?.verdict).toBe('likely_spam')
    expect(asked).toBe(0)
  })

  it('a server search hit carrying injection text reaches the model wrapped, and an excluded one not at all', async () => {
    const provider = new FakeEmailProvider(corpus.mailbox)
    const cache = new InMemoryEmailCache()
    const account = { ...provider.account, aieliaMayRead: true, excludedSenders: [] as string[] }
    const r = await runMailReadTool('mail_search', { text: 'reading this', scope: 'server' }, { account, cache, context: { chips: [] }, provider })
    expect(r.text).toMatch(INJECTION)
    expect(INJECTION.test(outsideWrapper(r.text)), 'injection text outside the wrapper (headers or snippet)').toBe(false)
    const hidden = await runMailReadTool('mail_search', { text: 'reading this', scope: 'server' }, { account: { ...account, excludedSenders: ['@wire-transfer-help.example.net'] }, cache, context: { chips: [] }, provider })
    expect(hidden.text).not.toMatch(INJECTION)
    expect((await searchMail({ text: 'reading this' }, 'server', { account, cache, provider, accept: () => false })).hits).toHaveLength(0)
  })
})
