import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import {
  MemoryService, DURABLE_FACTS_KEY, AUDIT_LOG_KEY, RETIRED_FACTS_KEY, ARCHIVED_FACTS_KEY, CONSOLIDATION_STATE_KEY,
  CONSOLIDATION_PROPOSALS_KEY, type AuditEntry,
} from './memory-service.js'
import { memoryConsolidationEnabled, proposeConsolidationOps, findArchiveCandidates, type ConsolidationProposal } from './memory-consolidation.js'
import type { UserFact } from './fact-extraction.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { PersonalAssistant } from './assistant.js'

type Answer = (input: { facts: Array<{ ref: string; text: string }> }) => unknown

/** A model double: `answer` sees the same JSON the real model would and returns its raw reply. Counts calls. */
function makeLlm(answer: Answer | 'throw' | 'garbage') {
  const client = {
    calls: 0,
    async *callChat() { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(messages: Array<{ role: string; content: string }>) {
      client.calls++
      if (answer === 'throw') throw new Error('boom')
      if (answer === 'garbage') return { content: 'not json at all' }
      const input = JSON.parse(messages[messages.length - 1].content)
      return { content: JSON.stringify(answer(input)) }
    },
  }
  return client
}
const refOf = (input: { facts: Array<{ ref: string; text: string }> }, text: string): string => {
  const hit = input.facts.find((f) => f.text === text)
  if (!hit) throw new Error(`no fact "${text}"`)
  return hit.ref
}

const T0 = '2026-01-01T00:00:00.000Z'
const fact = (text: string, over: Partial<UserFact> = {}): UserFact => ({
  text, extractedAt: T0, sourceTurn: 'turn:s', source: 'user_asserted', durable: true, ...over,
})
const id = (f: UserFact): string => `${f.text}|${f.extractedAt}`

function setup(facts: UserFact[], llm: ReturnType<typeof makeLlm>, budget?: number, auditSeed = true) {
  const memory = new InMemoryAdapter()
  const service = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm as never, () => undefined, () => '', budget ? () => budget : undefined)
  const seed = async () => {
    await memory.set(DURABLE_FACTS_KEY, facts)
    if (auditSeed) await memory.set(AUDIT_LOG_KEY, [{ seq: 1, at: T0, op: 'add', factId: id(facts[0]), after: facts[0], store: 'durable', writer: 'recordFacts', turn: 's' } satisfies AuditEntry])
  }
  return { memory, service, seed }
}
const snapshot = async (memory: InMemoryAdapter): Promise<string> =>
  JSON.stringify(await Promise.all([DURABLE_FACTS_KEY, RETIRED_FACTS_KEY, ARCHIVED_FACTS_KEY].map((k) => memory.get(k))))

// Legacy memory path (AUDIT_MEMORY_BUDGETED_RENDER=0) is the default for this file: the M5 gate/cost tests pin the pre-flip store behaviour; tests needing the budgeted render set '1' themselves.
beforeEach(() => { process.env.AUDIT_MEMORY_CONSOLIDATION = '1'; process.env.AUDIT_MEMORY_AUDIT_LOG = '1'; process.env.AUDIT_MEMORY_BUDGETED_RENDER = '0' })
afterEach(() => {
  for (const k of ['AUDIT_MEMORY_CONSOLIDATION', 'AUDIT_MEMORY_AUDIT_LOG', 'AUDIT_MEMORY_BUDGETED_RENDER', 'AUDIT_MEMORY_RETENTION_DAYS', 'AUDIT_MEMORY_WRITE_GATE']) delete process.env[k]
})

const PAIR = [fact('The user is vegetarian'), fact('The user does not eat meat', { extractedAt: '2026-01-02T00:00:00.000Z' }), fact('The user lives in Lisbon', { extractedAt: '2026-01-03T00:00:00.000Z' })]
const mergePair: Answer = (i) => ({ proposals: [{ kind: 'merge', refs: [refOf(i, PAIR[0].text), refOf(i, PAIR[1].text)], text: 'The user is vegetarian (eats no meat)', reason: 'same fact' }] })

describe('M5 consolidation: gate and cost', () => {
  it('flag off (default): disabled, zero model calls, nothing written (negative control)', async () => {
    delete process.env.AUDIT_MEMORY_CONSOLIDATION
    expect(memoryConsolidationEnabled()).toBe(false)
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    const before = await snapshot(memory)
    expect((await service.runConsolidation({ manual: true })).status).toBe('disabled')
    expect(llm.calls).toBe(0)
    expect(await memory.get(CONSOLIDATION_PROPOSALS_KEY)).toBeUndefined()
    expect(await snapshot(memory)).toBe(before)
    expect((await service.acceptProposal(0)).ok).toBe(false)
  })

  it('needs the audit log: without it nothing is proposed (an un-undoable change is never offered)', async () => {
    delete process.env.AUDIT_MEMORY_AUDIT_LOG
    const llm = makeLlm(mergePair)
    const { service, seed } = setup(PAIR, llm)
    await seed()
    expect((await service.runConsolidation({ manual: true })).status).toBe('needs_audit_log')
    expect(llm.calls).toBe(0)
  })

  it('no audit diff since the watermark and under budget: zero model calls, nothing written', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    await memory.set(CONSOLIDATION_STATE_KEY, { lastSeq: 1 })
    const result = await service.runConsolidation()
    expect(result).toMatchObject({ status: 'skipped', modelCalls: 0, proposed: 0 })
    expect(llm.calls).toBe(0)
    expect(await memory.get(CONSOLIDATION_PROPOSALS_KEY)).toBeUndefined()
  })

  it('an audit diff opens the gate (control for the previous test): exactly one call, watermark advances', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    const result = await service.runConsolidation()
    expect(result).toMatchObject({ status: 'ran', modelCalls: 1, proposed: 1 })
    expect(llm.calls).toBe(1)
    expect((await memory.get(CONSOLIDATION_STATE_KEY) as { lastSeq: number }).lastSeq).toBe(1)
    // Run again with no new changes: free.
    expect((await service.runConsolidation()).modelCalls).toBe(0)
    expect(llm.calls).toBe(1)
  })

  it('fewer than two live facts: no call even with a diff', async () => {
    const llm = makeLlm(mergePair)
    const { service, seed } = setup([PAIR[0]], llm)
    await seed()
    expect((await service.runConsolidation({ manual: true })).modelCalls).toBe(0)
  })

  it('two concurrent runs make one call', async () => {
    const llm = makeLlm(mergePair)
    const { service, seed } = setup(PAIR, llm)
    await seed()
    const [a, b] = await Promise.all([service.runConsolidation(), service.runConsolidation()])
    expect([a.status, b.status].sort()).toEqual(['busy', 'ran'])
    expect(llm.calls).toBe(1)
  })
})

describe('M5 consolidation: staged, never applied by the run', () => {
  it('a run only stages proposals: the stores are byte-identical afterwards', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    const before = await snapshot(memory)
    await service.runConsolidation()
    expect(await snapshot(memory)).toBe(before)
    const proposals = await service.getConsolidationProposals()
    expect(proposals).toHaveLength(1)
    expect(proposals[0].touchesUserAsserted).toBe(true)
  })

  it('a user_asserted fact is merged away only by an explicit accept of a staged proposal', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    await service.runConsolidation()
    let durable = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
    expect(durable.map((f) => f.text)).toContain('The user is vegetarian')
    const outcome = await service.acceptProposal(0)
    expect(outcome.ok).toBe(true)
    durable = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
    expect(durable.map((f) => f.text)).toEqual(['The user lives in Lisbon', 'The user is vegetarian (eats no meat)'])
    expect(durable[1].source).toBe('user_asserted')
    // Nothing is deleted: the originals are in the retired store.
    expect(((await memory.get(RETIRED_FACTS_KEY)) as UserFact[]).map((f) => f.text).sort()).toEqual(['The user does not eat meat', 'The user is vegetarian'])
  })

  it('textually similar facts the model keeps apart stay apart (the code decides nothing from words)', async () => {
    const llm = makeLlm(() => ({ proposals: [] }))
    const facts = [fact('The user likes Python'), fact('The user dislikes Python', { extractedAt: '2026-01-02T00:00:00.000Z' })]
    const { service, memory, seed } = setup(facts, llm)
    await seed()
    expect((await service.runConsolidation({ manual: true })).proposed).toBe(0)
    expect(await memory.get(CONSOLIDATION_PROPOSALS_KEY)).toBeUndefined()
  })

  it('a merge across projects is dropped by the structural check', async () => {
    const facts = [fact('Uses tabs', { project: 'a' }), fact('Prefers tabs', { project: 'b', extractedAt: '2026-01-02T00:00:00.000Z' })]
    const llm = makeLlm((i) => ({ proposals: [{ kind: 'merge', refs: [refOf(i, 'Uses tabs'), refOf(i, 'Prefers tabs')], text: 'Uses tabs', reason: 'x' }] }))
    const { service, seed } = setup(facts, llm)
    await seed()
    expect((await service.runConsolidation()).proposed).toBe(0)
  })

  it('dismissed proposals are not raised again', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    await service.runConsolidation()
    expect((await service.dismissProposal(0))?.kind).toBe('merge')
    await memory.set(AUDIT_LOG_KEY, [...((await memory.get(AUDIT_LOG_KEY)) as AuditEntry[]), { seq: 2, at: T0, op: 'add', factId: 'x', store: 'durable', writer: 'recordFacts', turn: 's' }])
    expect((await service.runConsolidation()).proposed).toBe(0)
  })
})

describe('M5 consolidation: failures change nothing', () => {
  it.each([['throws', 'throw' as const], ['unparseable', 'garbage' as const]])('a model call that %s: no proposals, watermark unmoved, retried next run', async (_n, mode) => {
    const llm = makeLlm(mode)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    const before = await snapshot(memory)
    expect((await service.runConsolidation()).status).toBe('failed')
    expect(await memory.get(CONSOLIDATION_PROPOSALS_KEY)).toBeUndefined()
    expect(await memory.get(CONSOLIDATION_STATE_KEY)).toBeUndefined()
    expect(await snapshot(memory)).toBe(before)
    // The gate is still open next time (the diff was not consumed).
    expect((await service.runConsolidation()).modelCalls).toBe(1)
    expect(llm.calls).toBe(2)
  })

  it('hostile but schema-valid answers are dropped one by one: unknown refs, reused refs, a one-fact merge, a self-superseding op', async () => {
    const llm = makeLlm((i) => {
      const a = refOf(i, PAIR[0].text); const b = refOf(i, PAIR[1].text); const c = refOf(i, PAIR[2].text)
      return { proposals: [
        { kind: 'merge', refs: [a, 'f999'], text: 'x', reason: '' },
        { kind: 'merge', refs: [a], text: 'x', reason: '' },
        { kind: 'supersede', refs: [a], by: a, reason: '' },
        { kind: 'delete_everything', refs: [a, b, c] },
        { kind: 'tighten', refs: [c], text: 'The user lives in Lisbon, Portugal', reason: 'ok' },
        { kind: 'tighten', refs: [c], text: 'again', reason: 'reused' },
      ] }
    })
    const { service, seed } = setup(PAIR, llm)
    await seed()
    const result = await service.runConsolidation()
    expect(result.proposed).toBe(1)
    expect((await service.getConsolidationProposals())[0].kind).toBe('tighten')
  })

  it('proposeConsolidationOps returns undefined (not []) on an unusable answer, so callers can tell failure from "nothing to do"', async () => {
    const input = { facts: [], recentChanges: [], budget: { usedChars: 0, budgetChars: 1 } }
    expect(await proposeConsolidationOps(input, makeLlm(() => ({ nope: 1 })) as never)).toBeUndefined()
    expect(await proposeConsolidationOps(input, makeLlm(() => ({ proposals: [] })) as never)).toEqual([])
  })
})

describe('M5 consolidation: apply then undo is the identity', () => {
  it('merge: undoing any one entry of the group restores durable, retired and archive stores byte for byte', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup([PAIR[2], ...PAIR.slice(0, 2)], llm)
    await seed()
    await service.runConsolidation()
    const before = await snapshot(memory)
    expect((await service.acceptProposal(0)).ok).toBe(true)
    expect(await snapshot(memory)).not.toBe(before)
    const entries = ((await memory.get(AUDIT_LOG_KEY)) as AuditEntry[]).filter((e) => e.group)
    expect(entries.length).toBe(2)
    expect((await service.undoAudit(entries[0].seq)).ok).toBe(true)
    expect(await snapshot(memory)).toBe(before)
    expect((await service.undoAudit(entries[1].seq)).ok).toBe(false) // already undone with the group
  })

  it('supersede and tighten also round-trip exactly, mid-list positions included', async () => {
    const facts = [fact('A'), fact('B', { extractedAt: '2026-01-02T00:00:00.000Z' }), fact('C', { extractedAt: '2026-01-03T00:00:00.000Z' }), fact('D', { extractedAt: '2026-01-04T00:00:00.000Z' })]
    const llm = makeLlm((i) => ({ proposals: [
      { kind: 'supersede', refs: [refOf(i, 'B')], by: refOf(i, 'C'), reason: 'C replaces B' },
      { kind: 'tighten', refs: [refOf(i, 'A')], text: 'A, shorter', reason: 'wording' },
    ] }))
    const { service, memory, seed } = setup(facts, llm)
    await seed()
    await service.runConsolidation()
    const before = await snapshot(memory)
    expect((await service.acceptProposal(0)).ok).toBe(true)
    expect((await service.acceptProposal(0)).ok).toBe(true)
    const log = (await memory.get(AUDIT_LOG_KEY)) as AuditEntry[]
    const groups = [...new Set(log.filter((e) => e.group).map((e) => e.group))]
    expect(groups).toHaveLength(2)
    expect(((await memory.get(DURABLE_FACTS_KEY)) as UserFact[]).map((f) => f.text)).toEqual(['C', 'D', 'A, shorter'])
    for (const g of groups.reverse()) await service.undoAudit(log.find((e) => e.group === g)!.seq)
    expect(await snapshot(memory)).toBe(before)
  })

  it('refuses to apply when the audit log is off, and drops a stale proposal', async () => {
    const llm = makeLlm(mergePair)
    const { service, memory, seed } = setup(PAIR, llm)
    await seed()
    await service.runConsolidation()
    delete process.env.AUDIT_MEMORY_AUDIT_LOG
    const before = await snapshot(memory)
    expect((await service.acceptProposal(0)).ok).toBe(false)
    expect(await snapshot(memory)).toBe(before)
    process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    await memory.set(DURABLE_FACTS_KEY, PAIR.slice(1))
    const stale = await service.acceptProposal(0)
    expect(stale.ok).toBe(false)
    expect(stale.message).toContain('stale')
    expect(await service.getConsolidationProposals()).toHaveLength(0)
  })
})

describe('M5 staged forgetting', () => {
  const OLD = '2025-01-01T00:00:00.000Z'
  const recent = new Date().toISOString()

  it('proposes archive for entries unreferenced past the retention window, with zero model calls', async () => {
    process.env.AUDIT_MEMORY_BUDGETED_RENDER = '1'
    const facts = [fact('stale never injected', { extractedAt: OLD }), fact('stale but injected lately', { extractedAt: OLD, injectedCount: 5, lastInjectedAt: recent }), fact('fresh', { extractedAt: recent })]
    const llm = makeLlm(() => ({ proposals: [] }))
    const { service, memory, seed } = setup(facts, llm, undefined, false)
    await seed()
    const result = await service.runConsolidation()
    expect(llm.calls).toBe(0)
    expect(result.status).toBe('ran')
    const proposals = await service.getConsolidationProposals()
    expect(proposals.map((p) => [p.kind, p.factIds[0]])).toEqual([['archive', id(facts[0])]])
    expect(proposals[0].reason).toContain('weaker than "used"')
    expect(await memory.get(ARCHIVED_FACTS_KEY)).toBeUndefined() // staged only
  })

  it('negative control: without usage tracking (budgeted render off) nothing is proposed for archive', async () => {
    const { service, seed } = setup([fact('stale', { extractedAt: OLD }), fact('stale too', { extractedAt: OLD })], makeLlm(() => ({ proposals: [] })), undefined, false)
    await seed()
    expect((await service.runConsolidation()).proposed).toBe(0)
    process.env.AUDIT_MEMORY_BUDGETED_RENDER = '1'
    expect((await service.runConsolidation()).proposed).toBe(2)
  })

  it('accept archives (never deletes): fact leaves the live store, sits in the archive, restorable; undo and restore round-trip', async () => {
    process.env.AUDIT_MEMORY_BUDGETED_RENDER = '1'
    const facts = [fact('keep', { extractedAt: recent }), fact('old one', { extractedAt: OLD }), fact('also keep', { extractedAt: recent })]
    const { service, memory, seed } = setup(facts, makeLlm(() => ({ proposals: [] })), undefined, false)
    await seed()
    await service.runConsolidation()
    const before = await snapshot(memory)
    expect((await service.acceptProposal(0)).ok).toBe(true)
    expect(((await memory.get(DURABLE_FACTS_KEY)) as UserFact[]).map((f) => f.text)).toEqual(['keep', 'also keep'])
    const archived = (await service.getArchivedFacts())
    expect(archived).toHaveLength(1)
    expect(archived[0].retiredAt).toBeTruthy()
    expect((await service.loadFacts('s')).factsBlock).not.toContain('old one')
    // restore, then undo the restore, then undo the archive: identity at the end
    const restored = await service.restoreArchivedFact(0)
    expect(restored?.text).toBe('old one')
    expect(await service.getArchivedFacts()).toHaveLength(0)
    const log = (await memory.get(AUDIT_LOG_KEY)) as AuditEntry[]
    const restoreEntry = log.find((e) => e.op === 'restore')!
    await service.undoAudit(restoreEntry.seq)
    expect(await service.getArchivedFacts()).toHaveLength(1)
    await service.undoAudit(log.find((e) => e.op === 'archive')!.seq)
    expect(await snapshot(memory)).toBe(before)
  })

  it('findArchiveCandidates uses timestamps only', () => {
    const now = Date.parse('2026-06-01T00:00:00Z')
    const out = findArchiveCandidates([fact('a', { extractedAt: '2026-01-01T00:00:00Z' }), fact('b', { extractedAt: '2026-01-01T00:00:00Z', lastInjectedAt: '2026-05-30T00:00:00Z' }), fact('c', { extractedAt: '2026-01-01T00:00:00Z', retiredAt: '2026-02-01T00:00:00Z' })], now, 90)
    expect(out.map((f) => f.text)).toEqual(['a'])
  })
})

describe('M5 exit gate: synthetic store of 60 facts, 15 duplicates, 10 superseded', () => {
  it('proposals cover them, the budgeted render fits after acceptance and still answers about a merged fact', async () => {
    process.env.AUDIT_MEMORY_BUDGETED_RENDER = '1'
    const facts: UserFact[] = []
    const at = (n: number): string => new Date(Date.now() - (100 - n) * 60_000).toISOString()
    let n = 0
    for (let k = 0; k < 15; k++) { facts.push(fact(`Topic ${k} detail first statement`, { extractedAt: at(n++) })); facts.push(fact(`Topic ${k} detail restated differently`, { extractedAt: at(n++) })) }
    for (let k = 0; k < 10; k++) { facts.push(fact(`Old setting ${k} was X`, { extractedAt: at(n++) })); facts.push(fact(`New setting ${k} is Y`, { extractedAt: at(n++) })) }
    for (let k = 0; k < 10; k++) facts.push(fact(`Singleton ${k}`, { extractedAt: at(n++) }))
    expect(facts.length).toBe(60)
    const llm = makeLlm((i) => ({ proposals: [
      ...Array.from({ length: 15 }, (_, k) => ({ kind: 'merge', refs: [refOf(i, `Topic ${k} detail first statement`), refOf(i, `Topic ${k} detail restated differently`)], text: `Topic ${k}: one fact`, reason: 'duplicate' })),
      ...Array.from({ length: 10 }, (_, k) => ({ kind: 'supersede', refs: [refOf(i, `Old setting ${k} was X`)], by: refOf(i, `New setting ${k} is Y`), reason: 'superseded' })),
    ] }))
    const { service, memory, seed } = setup(facts, llm, 1100)
    await seed()
    const result = await service.runConsolidation()
    expect(result.proposed).toBe(25)
    expect(result.usedChars!).toBeGreaterThan(1100) // over budget before
    expect(result.projectedChars!).toBeLessThanOrEqual(1100) // proposals bring it under, visibly
    const before = await service.loadFacts('s')
    expect(before.factsBlock.length).toBeGreaterThan(0)
    for (let k = 0; k < 25; k++) expect((await service.acceptProposal(0)).ok).toBe(true)
    const durable = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
    expect(durable).toHaveLength(35)
    const { factsBlock } = await service.loadFacts('s')
    expect(factsBlock.length).toBeLessThanOrEqual(1100)
    expect(service.lastDroppedCount).toBe(0)
    expect(factsBlock).toContain('Topic 7: one fact') // a question about a merged fact is still answerable from the block
    expect(factsBlock).toContain('New setting 3 is Y')
    expect(factsBlock).not.toContain('Old setting 3 was X')
  })
})

describe('M5 wiring', () => {
  it('the scripted client answers the consolidation side call inertly (no responses slot consumed)', async () => {
    const client = createScriptedLLMClient({})
    const out = await client.callChatStructured([{ role: 'system', content: 'You consolidate a small store of remembered facts about a user. x' }, { role: 'user', content: '{}' }])
    expect(out.content).toBe('{"proposals":[]}')
  })

  async function assistantWith(opts: { consolidateOnNewSession?: boolean }) {
    const memory = new InMemoryAdapter()
    await memory.set(DURABLE_FACTS_KEY, PAIR)
    await memory.set(AUDIT_LOG_KEY, [{ seq: 1, at: T0, op: 'add', factId: id(PAIR[0]), after: PAIR[0], store: 'durable', writer: 'recordFacts', turn: 's' }])
    const llm = makeLlm(mergePair)
    const assistant = await PersonalAssistant.create({ llmClient: llm as never, memory, ...opts })
    return { assistant, memory, llm }
  }

  it('/new triggers consolidation in the background when the host opted in', async () => {
    const { assistant, memory, llm } = await assistantWith({ consolidateOnNewSession: true })
    await assistant.clearSession('cli')
    await new Promise((r) => setTimeout(r, 20))
    expect(llm.calls).toBe(1)
    expect(((await memory.get(CONSOLIDATION_PROPOSALS_KEY)) as ConsolidationProposal[]).length).toBe(1)
    expect((await assistant.memoryProposals())).toHaveLength(1)
  })

  it('negative controls: not without the host option (chat-ui), not with the flag off', async () => {
    const a = await assistantWith({})
    await a.assistant.clearSession('cli')
    await new Promise((r) => setTimeout(r, 20))
    expect(a.llm.calls).toBe(0)
    delete process.env.AUDIT_MEMORY_CONSOLIDATION
    const b = await assistantWith({ consolidateOnNewSession: true })
    await b.assistant.clearSession('cli')
    await new Promise((r) => setTimeout(r, 20))
    expect(b.llm.calls).toBe(0)
  })

  it('the shared service methods drive accept, history and undo end to end', async () => {
    const { assistant, memory } = await assistantWith({})
    await assistant.proposeMemoryConsolidation('cli', true)
    const before = await snapshot(memory)
    expect((await assistant.acceptMemoryProposal('1', 'cli')).ok).toBe(true)
    const history = await assistant.memoryHistory()
    expect(history.some((e) => e.group?.startsWith('consolidation:'))).toBe(true)
    const entry = history.find((e) => e.group)!
    expect((await assistant.undoMemoryChange(String(entry.seq), 'cli')).ok).toBe(true)
    expect(await snapshot(memory)).toBe(before)
    expect((await assistant.acceptMemoryProposal('x', 'cli')).ok).toBe(false)
  })
})

describe('M5 structure', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  it('the consolidation module writes no store and contains no text-similarity code (D2)', () => {
    const src = readFileSync(resolve(dir, 'memory-consolidation.ts'), 'utf8')
    expect(src).not.toMatch(/\.set\(/)
    expect(src).not.toMatch(/levenshtein|jaccard|cosine|similarity\(|editDistance/i)
  })
  it('durable store is still written in exactly one place', () => {
    const src = readFileSync(resolve(dir, 'memory-service.ts'), 'utf8')
    expect(src.match(/\.set\(DURABLE_FACTS_KEY/g)).toHaveLength(1)
  })
})
