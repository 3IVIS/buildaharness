import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { syncAccount } from './sync.js'
import { InMemoryTriageStore, type TriageModel } from './triage.js'
import { catchUpSummary, estimateCatchUp, runCatchUp } from './catch-up.js'
import { generateLabelledCorpus } from './labelled-corpus.js'
import { windowSince } from './review-window.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
async function setup(opts: { aieliaMayRead?: boolean } = {}) {
  const corpus = generateLabelledCorpus({ seed: 2 })
  const p = new FakeEmailProvider(corpus.mailbox)
  const cache = new InMemoryEmailCache()
  await syncAccount(p, cache)
  const account = { ...p.account, aieliaMayRead: opts.aieliaMayRead ?? true }
  /** A scripted triage answering from the corpus's own verdicts: it reads no mail text. */
  const model: TriageModel & { calls: number } = Object.assign(async (_s: string, u: string) => {
    model.calls++
    const ids = [...u.matchAll(/^Thread ("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]!) as string)
    return JSON.stringify({ triage: ids.map((id) => ({ threadId: id, category: corpus.verdicts[id] === 'needs_response' ? 'person' : 'newsletter', needsReply: corpus.verdicts[id] === 'needs_response', priority: 'normal', urgency: corpus.verdicts[id] === 'needs_response' ? 'now' : 'none', reason: 'scripted' })) })
  }, { calls: 0 })
  return { corpus, p, cache, account, model, store: new InMemoryTriageStore() }
}

describe('catch-up', () => {
  it('estimates before running, and the estimate matches the run', async () => {
    const s = await setup()
    const est = await estimateCatchUp({ ...s, since: windowSince(30, NOW), batchSize: 10 })
    expect(est.toReview).toBe(est.inWindow)
    expect(est.calls).toBe(Math.ceil(est.toReview / 10))
    const r = await runCatchUp({ ...s, since: windowSince(30, NOW), batchSize: 10 })
    expect(s.model.calls).toBe(est.calls)
    expect(r.reviewed).toBe(est.toReview)
    expect(r.status).toBe('complete')
  })
  it('does not review sent, drafts, trash or junk threads', async () => {
    const s = await setup()
    const est = await estimateCatchUp({ ...s })
    const junkOnly = s.corpus.mailbox.threads.filter((t) => t.folderIds.every((f) => f === 'fld-junk' || f === 'fld-sent')).length
    expect(junkOnly).toBeGreaterThan(10)
    expect(est.inWindow).toBe(s.corpus.mailbox.threads.length - junkOnly)
  })
  it('lists what needs a response, most pressing first, and the labelled traps are among them', async () => {
    const s = await setup()
    const r = await runCatchUp({ ...s })
    const truth = Object.entries(s.corpus.verdicts).filter(([, v]) => v === 'needs_response').map(([t]) => t).sort()
    expect(r.needsResponse.map((n) => n.threadId).sort()).toEqual(truth)
    expect(r.urgent).toBe(truth.length)
    for (const t of s.corpus.traps.filter((x) => s.corpus.verdicts[x] === 'needs_response')) expect(r.needsResponse.some((n) => n.threadId === t)).toBe(true)
  })
  it('is resumable: a stopped run continues without re-reviewing', async () => {
    const s = await setup()
    let batches = 0
    const r1 = await runCatchUp({ ...s, batchSize: 5, shouldStop: () => ++batches > 2 })
    expect(r1.status).toBe('interrupted')
    const callsAfterFirst = s.model.calls
    expect(callsAfterFirst).toBe(2)
    const r2 = await runCatchUp({ ...s, batchSize: 5 })
    expect(r2.status).toBe('complete')
    expect(r1.reviewed + r2.reviewed).toBe((await estimateCatchUp({ ...s })).inWindow)
    // Nothing left: a third run makes no model call.
    const before = s.model.calls
    await runCatchUp({ ...s })
    expect(s.model.calls).toBe(before)
  })
  it('never overwrites a record the user corrected', async () => {
    const s = await setup()
    const tid = Object.entries(s.corpus.verdicts).find(([, v]) => v === 'needs_response')![0]
    await s.store.put({ threadId: tid, category: 'person', needsReply: false, priority: 'low', urgency: 'none', reason: 'mine', userOverridden: true, triagedAt: '2026-11-01T00:00:00.000Z' })
    const r = await runCatchUp({ ...s })
    expect((await s.store.get(tid))?.reason).toBe('mine')
    expect(r.needsResponse.some((n) => n.threadId === tid)).toBe(false)
  })
  it('sends no mail text to the model when the account is switched off, and says so', async () => {
    const s = await setup({ aieliaMayRead: false })
    const r = await runCatchUp({ ...s })
    expect(s.model.calls).toBe(0)
    expect(r.reviewed).toBe(0)
    expect(r.withheld).toBe(r.inWindow)
    expect(catchUpSummary(r).join('\n')).toMatch(/not reviewed/)
  })
  it('a failing model leaves threads unreviewed and reports it', async () => {
    const s = await setup()
    const r = await runCatchUp({ ...s, model: async () => { throw new Error('down') } })
    expect(r.reviewed).toBe(0)
    expect(r.failedCalls).toBeGreaterThan(0)
    expect(catchUpSummary(r).join('\n')).toMatch(/model call/)
  })
  it('respects the window and reports progress', async () => {
    const s = await setup()
    const seen: number[] = []
    const wide = await estimateCatchUp({ ...s })
    const narrow = await estimateCatchUp({ ...s, since: windowSince(7, NOW) })
    expect(narrow.inWindow).toBeLessThan(wide.inWindow)
    await runCatchUp({ ...s, since: windowSince(7, NOW), batchSize: 3, onProgress: (p) => seen.push(p.done) })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe(narrow.toReview)
  })
  it('summarises in plain words', async () => {
    const s = await setup()
    const r = await runCatchUp({ ...s })
    expect(catchUpSummary(r, 'Last 30 days')[0]).toMatch(/^\d+ of \d+ threads \(last 30 days\) need a response, \d+ urgent\.$/)
  })
})
