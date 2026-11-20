import { describe, expect, it } from 'vitest'
import { FakeEmailProvider } from './fake-provider.js'
import { InMemoryEmailCache } from './cache.js'
import { syncAccount } from './sync.js'
import { generateLabelledCorpus } from './labelled-corpus.js'
import { sampleJunkModel, sampleTriageModel } from './offline-session.js'
import { TRIAGE_SYSTEM_PROMPT } from './triage.js'
import { JUNK_SYSTEM_PROMPT } from './junk.js'
import { EmailWorkbench, type ModelFn, type WorkbenchEvent } from './workbench.js'

async function setup(chat?: ModelFn) {
  const corpus = generateLabelledCorpus()
  const provider = new FakeEmailProvider(corpus.mailbox)
  const writes: string[] = []
  for (const k of ['move', 'label', 'flag', 'markRead', 'createDraft', 'send', 'delete'] as const) {
    const orig = (provider[k] as (...a: unknown[]) => Promise<unknown>).bind(provider)
    ;(provider as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => { writes.push(k); return orig(...a) }
  }
  const cache = new InMemoryEmailCache()
  await syncAccount(provider, cache)
  const labels = corpus.mailbox.categoryByThread
  const triage = sampleTriageModel(labels), junk = sampleJunkModel(labels)
  const events: WorkbenchEvent[] = []
  const model: ModelFn = async (system, user) => (system === TRIAGE_SYSTEM_PROMPT ? triage(system, user) : system === JUNK_SYSTEM_PROMPT ? junk(system, user) : (chat ?? (async () => '{"answer":"ok"}'))(system, user))
  const wb = new EmailWorkbench({ provider, cache, model, now: () => '2026-11-02T00:00:00.000Z', onEvent: (e) => events.push(e), window: 'all' })
  await wb.refresh()
  return { wb, events, writes, corpus }
}

describe('EmailWorkbench', () => {
  it('catch-up finds the mail that needs a response and reports its model calls', async () => {
    const { wb, events } = await setup()
    const v = await wb.catchUp('all')
    expect(v.needsResponse.length).toBeGreaterThan(0)
    expect(events.some((e) => e.kind === 'model_end')).toBe(true)
    expect(wb.stats.calls).toBeGreaterThan(0)
  })
  it('builds a to-do list from what was reviewed', async () => {
    const { wb } = await setup()
    await wb.catchUp('all')
    expect((await wb.todo()).length).toBeGreaterThan(0)
  })
  it('spam is a proposal: it reviews first, and never writes', async () => {
    const { wb, writes } = await setup()
    const v = await wb.spam()
    expect(v.threads).toBeGreaterThan(0)
    expect(writes).toEqual([])
  })
  it('rule proposals come through the gate and are not applied', async () => {
    const { wb, writes } = await setup()
    const r = await wb.ruleProposals()
    expect(r.proposals.every((p) => p.heldByGate <= p.inboxHits)).toBe(true)
    expect(writes).toEqual([])
  })
  it('ask: the model calls a read-only tool, then answers, citing mail', async () => {
    let n = 0
    const { wb, events } = await setup(async () => (++n === 1 ? '{"tool":"mail_count","args":{}}' : '{"answer":"You have mail."}'))
    const a = await wb.ask('How many messages do I have?')
    expect(a.reply).toBe('You have mail.')
    expect(events.filter((e) => e.kind === 'tool' || e.kind === 'tool_result').length).toBe(2)
  })
  it('ask: an invented tool is refused, a model that never answers is stopped', async () => {
    const { wb } = await setup(async () => '{"tool":"mail_delete_everything","args":{}}')
    const a = await wb.ask('x')
    expect(a.reply).toMatch(/could not settle/)
  })
  it('ask: a tool call that tries a write tool is not run', async () => {
    let n = 0
    const { wb, writes } = await setup(async () => (++n === 1 ? '{"tool":"mail_move","args":{"ids":["a"]}}' : '{"answer":"done"}'))
    await wb.ask('move everything')
    expect(writes).toEqual([])
  })
  it('a failing model is reported, not swallowed silently', async () => {
    const { wb, events } = await setup(async () => { throw new Error('down') })
    await expect(wb.ask('x')).rejects.toThrow('down')
    expect(events.some((e) => e.kind === 'model_error')).toBe(true)
  })
  it('an empty window says so instead of returning an empty result', async () => {
    const { wb, events } = await setup()
    // The corpus is dated 2026-11-01; ask from a "now" long after, so a 7-day window holds nothing.
    const late = new EmailWorkbench({ provider: (wb as unknown as { o: { provider: never } }).o.provider, cache: (wb as unknown as { o: { cache: never } }).o.cache, model: async () => '{}', now: () => '2027-06-01T00:00:00.000Z', onEvent: (e) => events.push(e) })
    await late.refresh()
    const s = await late.spam(7)
    expect(s.threads).toBe(0)
    expect(s.note).toMatch(/nothing to check/)
    const c = await late.catchUp(7)
    expect(c.note).toMatch(/nothing to review/)
    expect(c.needsResponse).toEqual([])
  })
  it('spam takes the window it is given', async () => {
    const { wb } = await setup()
    expect((await wb.spam(90)).windowDays).toBe(90)
  })
})
