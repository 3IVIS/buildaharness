import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore } from '@buildaharness/runtime'
import type { ChatMessage, ILLMClient } from '@buildaharness/runtime'
import { InMemoryExperienceStore } from '@buildaharness/harness'
import { PersonalAssistant } from './assistant.js'
import { MemoryService, DURABLE_FACTS_KEY, PENDING_CONFIRMATION_KEY, ARCHIVED_FACTS_KEY, RETIRED_FACTS_KEY, AUDIT_LOG_KEY, CONSOLIDATION_PROPOSALS_KEY, type PendingFact, type AuditEntry } from './memory-service.js'
import { MemoryReviewer } from './memory-reviewer.js'
import { DIGEST_SYSTEM_MARKER, EPISODIC_INDEX_KEY } from './episodic-digest.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import type { UserFact } from './fact-extraction.js'

const REVIEWER_MARKER = 'You review what a user said across several turns'
const VERIFIER_MARKER = 'You check proposed memory entries against what a user actually said'
const CONSOLIDATE_MARKER = 'You consolidate a small store of remembered facts about a user'
const T0 = '2026-01-01T00:00:00.000Z'
const fact = (text: string, over: Partial<UserFact> = {}): UserFact => ({ text, extractedAt: T0, sourceTurn: 't', source: 'user_asserted', durable: true, ...over })

const DIGEST_BODY = { oneLine: 'Planned a trip', objective: 'Book travel', done: [], decisions: [], openItems: [], nextStep: 'Book' }
const FLUSH_FACT = { text: 'The user is allergic to penicillin', category: 'health', confidence: 'high', durable: true, containsSecret: false, looksLikeInstruction: false, evidence: 'I am allergic to penicillin' }
const REVIEW_OP = { kind: 'upsert', key: 'reply_format', text: 'Prefers short bullet-point replies', evidence: 'bullets please', scope: 'general', category: 'preference', containsSecret: false, redactedText: '', looksLikeInstruction: false }
const TRANSCRIPT: ChatMessage[] = [{ role: 'user', content: 'Too long. Bullets please.' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Still too long, bullets.' }]

/** One client that answers every memory writer's side call and counts each kind. */
function makeLlm() {
  const calls = { digest: 0, reviewer: 0, verifier: 0, consolidate: 0 }
  const base = createScriptedLLMClient({ responses: ['Ack.', 'Ack.', 'Ack.', 'Ack.', 'Ack.', 'Ack.'], streamChunks: ['Ack.'] })
  const llm: ILLMClient = {
    callChat: (m, o) => base.callChat(m, o),
    callChatSync: (m, o) => base.callChatSync(m, o),
    async callChatStructured(messages, tools, options) {
      const system = messages.find((m) => m.role === 'system')?.content ?? ''
      if (system.includes(DIGEST_SYSTEM_MARKER)) { calls.digest++; return { content: JSON.stringify({ digest: DIGEST_BODY, containsSecret: false, looksLikeInstruction: false, facts: [FLUSH_FACT] }) } }
      if (system.includes(REVIEWER_MARKER)) { calls.reviewer++; return { content: JSON.stringify({ ops: [REVIEW_OP] }) } }
      if (system.includes(VERIFIER_MARKER)) { calls.verifier++; return { content: JSON.stringify({ verdicts: [{ index: 0, supported: true, scopeFits: true, generalisesOneOff: false }] }) } }
      if (system.includes(CONSOLIDATE_MARKER)) { calls.consolidate++; return { content: JSON.stringify({ proposals: [] }) } }
      return base.callChatStructured(messages, tools, options)
    },
  }
  return { llm, calls }
}

function serviceSetup(mode: 'auto' | 'staged' | 'user_only' = 'staged') {
  const memory = new InMemoryAdapter()
  const { llm, calls } = makeLlm()
  const service = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm, () => undefined, () => '', undefined, () => mode)
  const reviewer = new MemoryReviewer(service, llm, () => undefined, async () => TRANSCRIPT)
  return { memory, service, reviewer, calls }
}
const pendingOf = async (m: InMemoryAdapter) => ((await m.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
const durableOf = async (m: InMemoryAdapter) => ((await m.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []
const ALL_FLAGS = ['AUDIT_MEMORY_REVIEWER', 'AUDIT_MEMORY_REVIEWER_EVERY', 'AUDIT_MEMORY_CONSOLIDATION', 'AUDIT_MEMORY_AUDIT_LOG', 'AUDIT_EPISODIC_DIGEST', 'AUDIT_MEMORY_WRITE_GATE']
beforeEach(() => { for (const k of ALL_FLAGS) delete process.env[k] })
afterEach(() => { for (const k of ALL_FLAGS) delete process.env[k] })

describe('M6 hooks: /memory off stops every later writer before any model call or write', () => {
  it('digest writer, compaction flush, reviewer and consolidation all do nothing while off, and resume after /memory on', async () => {
    process.env.AUDIT_EPISODIC_DIGEST = '1'; process.env.AUDIT_MEMORY_REVIEWER = '1'; process.env.AUDIT_MEMORY_CONSOLIDATION = '1'; process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    const { memory, service, reviewer, calls } = serviceSetup('auto')
    await memory.set(DURABLE_FACTS_KEY, [fact('a'), fact('b', { extractedAt: '2026-01-02T00:00:00.000Z' })])
    const before = JSON.stringify(await memory.get(DURABLE_FACTS_KEY))
    await service.setMemoryOff(true)

    expect(await service.writeSessionDigest('s', TRANSCRIPT)).toBeNull()
    expect(await service.flushBeforeCompaction('s', TRANSCRIPT)).toBe(0)
    expect((await reviewer.runNow('s')).proposed).toBe(0)
    expect((await service.runConsolidation({ manual: true })).status).toBe('disabled')
    expect(await service.consolidate('s')).toMatchObject({ status: 'blocked' })
    expect(calls).toEqual({ digest: 0, reviewer: 0, verifier: 0, consolidate: 0 })
    expect(await memory.get(EPISODIC_INDEX_KEY)).toBeUndefined()
    expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
    expect(JSON.stringify(await memory.get(DURABLE_FACTS_KEY))).toBe(before)
    expect(await memory.get(CONSOLIDATION_PROPOSALS_KEY)).toBeUndefined()

    await service.setMemoryOff(false)
    expect((await reviewer.runNow('s')).proposed).toBe(1)
    expect(await service.writeSessionDigest('s', TRANSCRIPT)).not.toBeNull()
    expect(calls.reviewer).toBe(1)
    expect(calls.digest).toBe(1)
  })

  it('stageReviewerOps itself refuses while off (a late-landing background review cannot write)', async () => {
    const { memory, service } = serviceSetup('auto')
    await service.setMemoryOff(true)
    const out = await service.stageReviewerOps('s', [{ kind: 'upsert', text: 'x', evidence: 'x', verification: 'supported' } as never], [])
    expect(out).toMatchObject({ staged: 0, sessionScoped: 0 })
    expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
    expect(await memory.get(DURABLE_FACTS_KEY)).toBeUndefined()
  })

  it('accepting a staged consolidation proposal is a write: refused while off', async () => {
    process.env.AUDIT_MEMORY_CONSOLIDATION = '1'; process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    const { service } = serviceSetup()
    await service.setMemoryOff(true)
    expect((await service.acceptProposal(0)).ok).toBe(false)
  })
})

describe('M6 hooks: cross-turn writers route through submitCandidate (memoryWriteMode + the M2 gate)', () => {
  it.each([['staged', 'pending'], ['user_only', 'pending'], ['auto', 'durable']] as const)('compaction flush in %s mode lands in %s, audited as writer "digest"', async (mode, where) => {
    process.env.AUDIT_EPISODIC_DIGEST = '1'; process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    const { memory, service } = serviceSetup(mode)
    expect(await service.flushBeforeCompaction('s', TRANSCRIPT)).toBe(1)
    const target = where === 'pending' ? await pendingOf(memory) : await durableOf(memory)
    expect(target.map((f) => f.text)).toEqual([FLUSH_FACT.text])
    expect((where === 'pending' ? await durableOf(memory) : await pendingOf(memory))).toEqual([])
    const log = (await memory.get(AUDIT_LOG_KEY)) as AuditEntry[]
    expect(log.map((e) => e.writer)).toEqual(['digest'])
  })

  it('a flush candidate with no judgement stays out even with the env write gate off (forced gate, fail closed)', async () => {
    process.env.AUDIT_EPISODIC_DIGEST = '1'
    const memory = new InMemoryAdapter()
    const llm = { async *callChat() { yield '' }, async callChatSync() { return '' }, async callChatStructured() { return { content: JSON.stringify({ digest: DIGEST_BODY, containsSecret: false, looksLikeInstruction: false, facts: [{ ...FLUSH_FACT, containsSecret: undefined, looksLikeInstruction: undefined }] }) } } } as unknown as ILLMClient
    const service = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm, () => undefined)
    expect(await service.flushBeforeCompaction('s', TRANSCRIPT)).toBe(0)
    expect(await pendingOf(memory)).toEqual([])
  })

  it('reviewer upserts follow the write mode: staged queues them with stagedBy, auto writes them durable (audit writer "reviewer")', async () => {
    process.env.AUDIT_MEMORY_REVIEWER = '1'; process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    const staged = serviceSetup('staged')
    expect((await staged.reviewer.runNow('s')).stage?.staged).toBe(1)
    expect((await pendingOf(staged.memory))[0]).toMatchObject({ stagedBy: 'reviewer', verification: 'supported' })
    expect(await durableOf(staged.memory)).toEqual([])

    const auto = serviceSetup('auto')
    expect((await auto.reviewer.runNow('s')).stage?.staged).toBe(1)
    expect((await durableOf(auto.memory)).map((f) => f.text)).toEqual([REVIEW_OP.text])
    expect(((await auto.memory.get(AUDIT_LOG_KEY)) as AuditEntry[]).map((e) => e.writer)).toEqual(['reviewer'])
  })
})

describe('M6 hooks: archive, export and digests are one coverage', () => {
  async function seeded() {
    const memory = new InMemoryAdapter()
    const { llm } = makeLlm()
    const assistant = new PersonalAssistant({ llmClient: llm, memory })
    const archived = fact('set aside fact', { retiredAt: '2026-02-01T00:00:00.000Z' })
    const replaced = fact('replaced fact', { extractedAt: '2026-01-05T00:00:00.000Z', retiredAt: '2026-03-01T00:00:00.000Z' })
    await memory.set(ARCHIVED_FACTS_KEY, [archived])
    await memory.set(RETIRED_FACTS_KEY, [replaced])
    return { memory, assistant, archived, replaced }
  }

  it('listArchive is one numbered list: set-aside (restorable) first, then replaced; export carries both', async () => {
    const { assistant } = await seeded()
    expect((await assistant.listArchivedFacts()).map((f) => f.text)).toEqual(['set aside fact', 'replaced fact'])
    expect(await assistant.restorableArchiveCount()).toBe(1)
    expect((await assistant.exportMemory('s')).retired?.map((f) => f.text)).toEqual(['set aside fact', 'replaced fact'])
  })

  it('/memory archive restore <n> brings a set-aside fact back (and refuses a replaced one); forget <n> erases from either store', async () => {
    const { assistant, memory } = await seeded()
    expect((await assistant.restoreArchivedMemory('2', 's')).ok).toBe(false) // replaced entries are not restorable
    expect((await assistant.restoreArchivedMemory('1', 's')).ok).toBe(true)
    expect((await durableOf(memory)).map((f) => f.text)).toEqual(['set aside fact'])
    expect(await memory.get(ARCHIVED_FACTS_KEY)).toEqual([])
    expect((await assistant.forgetArchivedFact('1')).ok).toBe(true) // the replaced one, now first
    expect(await memory.get(RETIRED_FACTS_KEY)).toEqual([])
    // erase from the set-aside store too
    await memory.set(ARCHIVED_FACTS_KEY, [fact('another', { retiredAt: T0 })])
    expect((await assistant.forgetArchivedFact('1')).ok).toBe(true)
    expect(await memory.get(ARCHIVED_FACTS_KEY)).toEqual([])
  })

  it('digests are in /memory export and erased by forgetDigests; /memory off stops new ones', async () => {
    process.env.AUDIT_EPISODIC_DIGEST = '1'
    const memory = new InMemoryAdapter()
    const { llm } = makeLlm()
    const assistant = new PersonalAssistant({ llmClient: llm, memory })
    await assistant.turn('Help me plan a trip', { sessionId: 'cli' })
    await assistant.clearSession('cli')
    expect((await assistant.exportMemory('cli')).digests).toHaveLength(1)
    expect(await assistant.listSessionDigests()).toHaveLength(1)
    expect(await assistant.forgetDigests()).toBe(1)
    expect((await assistant.exportMemory('cli')).digests).toHaveLength(0)
    await assistant.setMemoryEnabled(false)
    await assistant.turn('another conversation', { sessionId: 'cli' })
    await assistant.clearSession('cli')
    expect(await assistant.listSessionDigests()).toHaveLength(0)
  })
})

describe('M6 hooks: consolidation registration and the writer-flag guard', () => {
  it('every PersonalAssistant registers the consolidator itself (a /config-set rebuild loses nothing); flag off says so, flag on stages proposals', async () => {
    const memory = new InMemoryAdapter()
    const { llm, calls } = makeLlm()
    const a = new PersonalAssistant({ llmClient: llm, memory })
    expect(await a.consolidateMemory('s')).toMatchObject({ status: 'nothing_to_do', message: expect.stringContaining('off') })
    expect(calls.consolidate).toBe(0)
    const b = new PersonalAssistant({ llmClient: llm, memory })
    expect((await b.consolidateMemory('s')).status).not.toBe('unavailable')
    process.env.AUDIT_MEMORY_CONSOLIDATION = '1'; process.env.AUDIT_MEMORY_AUDIT_LOG = '1'
    await memory.set(DURABLE_FACTS_KEY, [fact('a'), fact('b', { extractedAt: '2026-01-02T00:00:00.000Z' })])
    await b.consolidateMemory('s')
    expect(calls.consolidate).toBe(1)
  })

  it('with the writer flags off (the default, and always in a browser tab) turns, /new and the memory panel hooks make no reviewer, digest or consolidation call', async () => {
    const memory = new InMemoryAdapter()
    const { llm, calls } = makeLlm()
    const assistant = new PersonalAssistant({ llmClient: llm, memory, consolidateOnNewSession: true })
    expect(assistant.memoryWriterFlags()).toEqual({ reviewer: false, consolidation: false, digest: false })
    for (let i = 0; i < 6; i++) await assistant.turn(`message number ${i}`, { sessionId: 'cli' })
    await assistant.awaitMemoryReview()
    await assistant.clearSession('cli')
    await assistant.consolidateMemory('cli')
    expect(calls).toEqual({ digest: 0, reviewer: 0, verifier: 0, consolidate: 0 })
  })
})
