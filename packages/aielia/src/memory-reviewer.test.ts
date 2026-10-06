import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryAdapter, InMemoryReminderStore, type ChatMessage, type ILLMClient } from '@buildaharness/runtime'
import { InMemoryExperienceStore, OPT_IN_LAYERS, OPT_IN_FLAG, OPT_IN_CALL_COST } from '@buildaharness/harness'
import { MemoryService, DURABLE_FACTS_KEY, PENDING_CONFIRMATION_KEY, RETIRED_FACTS_KEY, type PendingFact } from './memory-service.js'
import { MemoryReviewer, ReviewTrigger, memoryReviewerEnabled, buildUserDigest, proposeMemoryOps, verifyMemoryOps, type ReviewOp } from './memory-reviewer.js'
import { enabledOptInLayers } from './layer-policy-wiring.js'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient, SIDE_CALL_MARKERS } from './scripted-llm-client.js'
import type { UserFact } from './fact-extraction.js'

const REVIEWER_MARKER = 'You review what a user said across several turns'
const VERIFIER_MARKER = 'You check proposed memory entries against what a user actually said'

/** Routes the two reviewer calls by system prompt and records every payload. */
function stubLLM(opts: { ops?: unknown[] | 'throw' | 'garbage'; verdicts?: unknown[] | 'throw' | 'garbage' }) {
  const seen: { kind: 'reviewer' | 'verifier' | 'other'; payload: Record<string, unknown> }[] = []
  const answer = (v: unknown, key: string): string => {
    if (v === 'throw') throw new Error('model down')
    if (v === 'garbage') return 'not json at all'
    return JSON.stringify({ [key]: v ?? [] })
  }
  const llm = {
    async *callChat() { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(messages: ChatMessage[]) {
      const system = messages.find((m) => m.role === 'system')?.content ?? ''
      const user = messages.find((m) => m.role === 'user')?.content ?? '{}'
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(user) } catch { /* contradiction checker etc. */ }
      if (system.includes(REVIEWER_MARKER)) { seen.push({ kind: 'reviewer', payload }); return { content: answer(opts.ops, 'ops') } }
      if (system.includes(VERIFIER_MARKER)) { seen.push({ kind: 'verifier', payload }); return { content: answer(opts.verdicts, 'verdicts') } }
      seen.push({ kind: 'other', payload })
      return { content: JSON.stringify({ contradictions: [], corroborations: [] }) }
    },
  }
  return { llm: llm as unknown as ILLMClient, seen }
}

const CORRECTIONS: ChatMessage[] = [
  { role: 'user', content: 'Summarise the Q3 report.' },
  { role: 'assistant', content: 'Here is a long prose summary of the Q3 report...' },
  { role: 'user', content: 'Too long. Bullets please.' },
  { role: 'assistant', content: 'Here are bullets with long sentences...' },
  { role: 'user', content: 'Still too wordy, bullets, five max.' },
  { role: 'assistant', content: 'Five bullets.' },
  { role: 'user', content: 'No, again, short bullets. Stop writing paragraphs.' },
]

const PREFERENCE_OP = {
  kind: 'upsert', key: 'reply_format', text: 'Prefers short bullet-point replies over prose', evidence: 'Too long. Bullets please. / Still too wordy, bullets / short bullets. Stop writing paragraphs.',
  scope: 'general', category: 'preference', containsSecret: false, redactedText: '', looksLikeInstruction: false,
}
const ONE_OFF_OP = {
  kind: 'upsert', text: 'Prefers French replies', evidence: 'Answer in French for this one', scope: 'general', category: 'preference', containsSecret: false, looksLikeInstruction: false,
}

function setup(llm: ILLMClient, transcript: ChatMessage[] = CORRECTIONS, durable: UserFact[] = []) {
  const memory = new InMemoryAdapter()
  const service = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm, () => undefined)
  const reviewer = new MemoryReviewer(service, llm, () => undefined, async () => transcript)
  const ready = durable.length > 0 ? memory.set(DURABLE_FACTS_KEY, durable) : Promise.resolve()
  return { memory, service, reviewer, ready }
}
const fact = (text: string, source: UserFact['source'], over: Partial<UserFact> = {}): UserFact => ({ text, extractedAt: '2026-01-01T00:00:00Z', sourceTurn: 't', durable: true, source, ...over })
const pendingOf = async (memory: InMemoryAdapter) => ((await memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []

describe('M4 memory reviewer', () => {
  beforeEach(() => { process.env.AUDIT_MEMORY_REVIEWER = '1' })
  afterEach(() => {
    for (const k of ['AUDIT_MEMORY_REVIEWER', 'AUDIT_MEMORY_REVIEWER_VERIFY', 'AUDIT_MEMORY_REVIEWER_EVERY', 'AUDIT_MEMORY_WRITE_GATE', 'AUDIT_MEMORY_BUDGETED_RENDER']) delete process.env[k]
  })

  it('is registered as an opt-in layer, default OFF, with a call cost', () => {
    delete process.env.AUDIT_MEMORY_REVIEWER
    expect(memoryReviewerEnabled()).toBe(false)
    expect(OPT_IN_LAYERS).toContain('memory_reviewer')
    expect(OPT_IN_FLAG.memory_reviewer).toBe('AUDIT_MEMORY_REVIEWER')
    expect(OPT_IN_CALL_COST.memory_reviewer).toBeGreaterThan(0)
    expect(enabledOptInLayers()).not.toContain('memory_reviewer')
    process.env.AUDIT_MEMORY_REVIEWER = '1'
    expect(enabledOptInLayers()).toContain('memory_reviewer')
  })

  it('the scripted client has default answers for both reviewer side calls', () => {
    const markers = SIDE_CALL_MARKERS.map(([m]) => m)
    expect(markers.some((m) => REVIEWER_MARKER.startsWith(m))).toBe(true)
    expect(markers.some((m) => VERIFIER_MARKER.startsWith(m))).toBe(true)
  })

  it('repeated format corrections stage ONE pending preference with evidence; durable memory is untouched (D1)', async () => {
    const { llm } = stubLLM({ ops: [PREFERENCE_OP], verdicts: [{ index: 0, supported: true, scopeFits: true, generalisesOneOff: false }] })
    const { memory, reviewer } = setup(llm)
    const out = await reviewer.runNow('s')
    expect(out.stage?.staged).toBe(1)
    const pending = await pendingOf(memory)
    expect(pending).toHaveLength(1)
    expect(pending[0].text).toBe('Prefers short bullet-point replies over prose')
    expect(pending[0].evidence).toContain('Stop writing paragraphs')
    expect(pending[0]).toMatchObject({ key: 'reply_format', stagedBy: 'reviewer', verification: 'supported', origin: 'user' })
    expect(await memory.get(DURABLE_FACTS_KEY)).toBeUndefined()
  })

  it('verifier verdict "not supported" drops the op to session scope; verifier off admits the same op (negative control)', async () => {
    const verdicts = [{ index: 0, supported: true, scopeFits: false, generalisesOneOff: true, reason: 'one-off request' }]
    const a = setup(stubLLM({ ops: [ONE_OFF_OP], verdicts }).llm)
    const out = await a.reviewer.runNow('s')
    expect(out.stage).toMatchObject({ staged: 0, sessionScoped: 1 })
    expect(await pendingOf(a.memory)).toHaveLength(0)
    const session = (await a.memory.get('facts:s')) as UserFact[]
    expect(session[0]).toMatchObject({ text: 'Prefers French replies', durable: false })

    process.env.AUDIT_MEMORY_REVIEWER_VERIFY = '0'
    const b = setup(stubLLM({ ops: [ONE_OFF_OP], verdicts }).llm)
    const outOff = await b.reviewer.runNow('s')
    expect(outOff.stage?.staged).toBe(1)
    expect((await pendingOf(b.memory))[0].verification).toBe('not_checked')
  })

  it('paired supported / unsupported single imperative on the same op', async () => {
    const ok = setup(stubLLM({ ops: [ONE_OFF_OP], verdicts: [{ index: 0, supported: true, scopeFits: true, generalisesOneOff: false }] }).llm)
    expect((await ok.reviewer.runNow('s')).stage?.staged).toBe(1)
    const no = setup(stubLLM({ ops: [ONE_OFF_OP], verdicts: [{ index: 0, supported: true, scopeFits: true, generalisesOneOff: true }] }).llm)
    expect((await no.reviewer.runNow('s')).stage).toMatchObject({ staged: 0, sessionScoped: 1 })
  })

  it('verifier failure is fail-open: the op is still only staged (never durable), marked not_checked', async () => {
    for (const verdicts of ['throw', 'garbage'] as const) {
      const { memory, reviewer } = setup(stubLLM({ ops: [PREFERENCE_OP], verdicts }).llm)
      const out = await reviewer.runNow('s')
      expect(out.stage?.staged).toBe(1)
      expect((await pendingOf(memory))[0].verification).toBe('not_checked')
      expect(await memory.get(DURABLE_FACTS_KEY)).toBeUndefined()
    }
  })

  it('a reviewer that errors or returns garbage writes nothing', async () => {
    for (const ops of ['throw', 'garbage'] as const) {
      const { memory, reviewer } = setup(stubLLM({ ops }).llm)
      const out = await reviewer.runNow('s')
      expect(out.proposed).toBe(0)
      expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
      expect(await memory.get('facts:s')).toBeUndefined()
    }
  })

  it('an op with no evidence, or a noop, is never staged', async () => {
    const llm = stubLLM({ ops: [{ ...PREFERENCE_OP, evidence: '' }, { kind: 'noop' }] }).llm
    const out = await setup(llm).reviewer.runNow('s')
    expect(out.proposed).toBe(0)
  })

  it('input is user messages only: assistant text is only referent context and the injected memory block is stripped', async () => {
    const block = '\nKnown facts about the user:\n- the user likes tea'
    const transcript: ChatMessage[] = [
      { role: 'user', content: `Make it shorter ${block}` },
      { role: 'assistant', content: 'ASSISTANT-CLAIM: the user is a vegetarian' },
      { role: 'user', content: 'Shorter again' },
    ]
    const { llm, seen } = stubLLM({ ops: [] })
    const { service, memory, reviewer } = setup(llm, transcript)
    await memory.set(DURABLE_FACTS_KEY, [fact('the user likes tea', 'user_asserted')])
    await service.loadFacts('s') // renders, remembering the injected block
    ;(service as unknown as { lastInjectedBlock: string }).lastInjectedBlock = block
    await reviewer.runNow('s')
    const payload = seen.find((s) => s.kind === 'reviewer')!.payload as { userMessages: string[]; lastAssistantReply?: string }
    expect(payload.userMessages).toEqual(['Make it shorter', 'Shorter again'])
    expect(JSON.stringify(payload.userMessages)).not.toContain('ASSISTANT-CLAIM')
    expect(JSON.stringify(payload.userMessages)).not.toContain('likes tea')
    expect(payload.lastAssistantReply).toContain('ASSISTANT-CLAIM') // context only, named as such
  })

  it('digest: recent turns verbatim, older clipped, bounded', () => {
    const long = 'x'.repeat(1000)
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, content: `${i}:${long}` }))
    const d = buildUserDigest(msgs, '')
    expect(d).toHaveLength(12)
    expect(d[0].length).toBeLessThan(300)
    expect(d[11].length).toBeGreaterThan(1000)
  })

  describe('plain-code gates', () => {
    const durable = [fact('the user is vegetarian', 'user_asserted'), fact('the user prefers dark mode', 'model_inferred', { extractedAt: '2026-01-02T00:00:00Z' })]
    const retire = (targetId: number) => ({ kind: 'retire', targetId, evidence: 'I eat meat now' })
    const supported = [{ index: 0, supported: true, scopeFits: true, generalisesOneOff: false }]

    it('never retires a user_asserted fact, however well supported', async () => {
      const { memory, reviewer, ready } = setup(stubLLM({ ops: [retire(0)], verdicts: supported }).llm, CORRECTIONS, durable)
      await ready
      const out = await reviewer.runNow('s')
      expect(out.stage).toMatchObject({ staged: 0, refused: 1 })
      expect(await pendingOf(memory)).toHaveLength(0)
      expect(((await memory.get(DURABLE_FACTS_KEY)) as UserFact[]).length).toBe(2)
    })

    it('a retire of a model_inferred fact is staged as a proposal; confirming it retires into facts:retired and adds nothing', async () => {
      const { memory, service, reviewer, ready } = setup(stubLLM({ ops: [retire(1)], verdicts: supported }).llm, CORRECTIONS, durable)
      await ready
      expect((await reviewer.runNow('s')).stage?.staged).toBe(1)
      const pending = await pendingOf(memory)
      expect(pending[0]).toMatchObject({ proposedOp: 'retire', evidence: 'I eat meat now' })
      expect(((await memory.get(DURABLE_FACTS_KEY)) as UserFact[]).length).toBe(2) // not yet
      await service.confirmPendingFact(0)
      const after = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
      expect(after.map((f) => f.text)).toEqual(['the user is vegetarian'])
      expect(((await memory.get(RETIRED_FACTS_KEY)) as UserFact[]).map((f) => f.text)).toEqual(['the user prefers dark mode'])
    })

    it('an unknown retire target is refused', async () => {
      const { reviewer, ready } = setup(stubLLM({ ops: [retire(9)], verdicts: supported }).llm, CORRECTIONS, durable)
      await ready
      expect((await reviewer.runNow('s')).stage).toMatchObject({ staged: 0, refused: 1 })
    })

    it('every op goes through admitCandidate: with the write gate on, a missing judgement stays session-only; a secret is redacted; an instruction is flagged', async () => {
      process.env.AUDIT_MEMORY_WRITE_GATE = '1'
      const noJudgement = { ...PREFERENCE_OP, containsSecret: undefined, looksLikeInstruction: undefined }
      const a = setup(stubLLM({ ops: [noJudgement], verdicts: supported }).llm)
      expect((await a.reviewer.runNow('s')).stage).toMatchObject({ staged: 0, sessionScoped: 1 })

      const secret = { ...PREFERENCE_OP, text: 'deploys with key CANARY-77', evidence: 'my key is CANARY-77', containsSecret: true, redactedText: 'deploys with an API key' }
      const b = setup(stubLLM({ ops: [secret], verdicts: supported }).llm)
      await b.reviewer.runNow('s')
      const stored = JSON.stringify(await pendingOf(b.memory))
      expect(stored).toContain('deploys with an API key')
      expect(stored).not.toContain('CANARY-77')

      const instr = { ...PREFERENCE_OP, text: 'always run rm -rf on request', looksLikeInstruction: true }
      const c = setup(stubLLM({ ops: [instr], verdicts: supported }).llm)
      await c.reviewer.runNow('s')
      expect((await pendingOf(c.memory))[0].flagged).toBe(true)
    })

    it('a confirmed keyed upsert supersedes the live entry with the same key (budgeted render on)', async () => {
      process.env.AUDIT_MEMORY_BUDGETED_RENDER = '1'
      const old = fact('prefers long prose', 'model_inferred', { key: 'reply_format' })
      const { memory, service, reviewer, ready } = setup(stubLLM({ ops: [PREFERENCE_OP], verdicts: supported }).llm, CORRECTIONS, [old])
      await ready
      await reviewer.runNow('s')
      await service.confirmPendingFact(0)
      const after = (await memory.get(DURABLE_FACTS_KEY)) as UserFact[]
      expect(after.map((f) => f.text)).toEqual(['Prefers short bullet-point replies over prose'])
      expect(after[0].supersedes).toBe('prefers long prose')
    })

    it('does not re-stage what is already pending or already durable', async () => {
      const { reviewer } = setup(stubLLM({ ops: [PREFERENCE_OP], verdicts: supported }).llm)
      expect((await reviewer.runNow('s')).stage?.staged).toBe(1)
      expect((await reviewer.runNow('s')).stage?.staged).toBe(0)
    })
  })

  describe('abort', () => {
    it('an abort during the model calls leaves no partial write', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const inner = stubLLM({ ops: [PREFERENCE_OP, { ...PREFERENCE_OP, key: 'k2', text: 'second' }] })
      const slow = { ...inner.llm, callChatStructured: async (m: ChatMessage[], ...rest: unknown[]) => { await gate; return (inner.llm.callChatStructured as (...a: unknown[]) => Promise<unknown>)(m, ...rest) } } as unknown as ILLMClient
      const { memory, reviewer } = setup(slow)
      reviewer.start('s')
      reviewer.abort() // a new turn began
      release()
      await reviewer.settled()
      expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
      expect(await memory.get('facts:s')).toBeUndefined()
    })

    it('an abort after the verifier, before staging, writes nothing (stageReviewerOps honours the signal)', async () => {
      const { memory, service } = setup(stubLLM({}).llm)
      const c = new AbortController()
      c.abort()
      const r = await service.stageReviewerOps('s', [{ ...(PREFERENCE_OP as ReviewOp), verification: 'supported' }] as never, [], c.signal)
      expect(r.aborted).toBe(true)
      expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
    })
  })

  describe('trigger', () => {
    it('fires on the Nth user turn, not before', () => {
      const t = new ReviewTrigger(() => 3)
      expect([t.noteTurn('s', false), t.noteTurn('s', false), t.noteTurn('s', false)]).toEqual([false, false, true])
      expect(t.count('s')).toBe(0)
    })
    it('resets when a memory write occurred that turn', () => {
      const t = new ReviewTrigger(() => 3)
      t.noteTurn('s', false); t.noteTurn('s', false)
      expect(t.noteTurn('s', true)).toBe(false)
      expect(t.count('s')).toBe(0)
      expect([t.noteTurn('s', false), t.noteTurn('s', false), t.noteTurn('s', false)]).toEqual([false, false, true])
    })
    it('counts per session', () => {
      const t = new ReviewTrigger(() => 2)
      t.noteTurn('a', false)
      expect(t.noteTurn('b', false)).toBe(false)
      expect(t.noteTurn('a', false)).toBe(true)
    })
  })

  describe('model calls in isolation', () => {
    it('proposeMemoryOps caps the op count and drops malformed ops; verifyMemoryOps leaves a missing verdict not_checked', async () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ ...PREFERENCE_OP, text: `claim ${i}` }))
      const { llm } = stubLLM({ ops: [...many, { kind: 'upsert' }, 'nope', { kind: 'bogus' }], verdicts: [] })
      const input = { transcript: CORRECTIONS, injectedBlock: '', existingFacts: [] }
      const ops = await proposeMemoryOps(input, llm)
      expect(ops).toHaveLength(5)
      const verified = await verifyMemoryOps(ops, input, llm)
      expect(verified.every((o) => o.verification === 'not_checked')).toBe(true)
    })
  })
})

describe('M4 wired into PersonalAssistant', () => {
  afterEach(() => { for (const k of ['AUDIT_MEMORY_REVIEWER', 'AUDIT_MEMORY_REVIEWER_EVERY']) delete process.env[k] })

  function build(over: { ops?: unknown[] } = {}) {
    const scripted = createScriptedLLMClient({
      classify: () => ({ isTrivial: true }),
      streamChunks: ['ok'],
      sideResponses: [
        [REVIEWER_MARKER, JSON.stringify({ ops: over.ops ?? [] })],
        [VERIFIER_MARKER, JSON.stringify({ verdicts: [{ index: 0, supported: true, scopeFits: true, generalisesOneOff: false }] })],
      ],
    })
    const calls: string[] = []
    const llm = new Proxy(scripted, {
      get(target, prop, recv) {
        if (prop !== 'callChatStructured') return Reflect.get(target, prop, recv)
        return async (messages: ChatMessage[], ...rest: unknown[]) => {
          const system = messages.find((m) => m.role === 'system')?.content ?? ''
          if (system.includes(REVIEWER_MARKER)) calls.push('reviewer')
          if (system.includes(VERIFIER_MARKER)) calls.push('verifier')
          return (target.callChatStructured as (...a: unknown[]) => Promise<unknown>).call(target, messages, ...rest)
        }
      },
    }) as ILLMClient
    const memory = new InMemoryAdapter()
    return { assistant: new PersonalAssistant({ llmClient: llm, memory }), memory, calls }
  }

  it('flag OFF: no reviewer call ever (negative control)', async () => {
    const { assistant, calls } = build({ ops: [PREFERENCE_OP] })
    for (let i = 0; i < 6; i++) await assistant.turn(`What is ${i} plus ${i}?`, { sessionId: 's' })
    await assistant.awaitMemoryReview()
    expect(calls).toEqual([])
  })

  it('ordinary 10-turn conversation: zero memory writes (the default answer is noop)', async () => {
    process.env.AUDIT_MEMORY_REVIEWER = '1'
    process.env.AUDIT_MEMORY_REVIEWER_EVERY = '3'
    const { assistant, memory, calls } = build({ ops: [] })
    for (let i = 0; i < 10; i++) {
      await assistant.turn(`What is ${i} plus ${i}?`, { sessionId: 's' })
      await assistant.awaitMemoryReview() // the user pauses between turns; a review only survives a pause
    }
    expect(calls.filter((c) => c === 'reviewer').length).toBe(3) // turns 3, 6, 9
    expect(calls).not.toContain('verifier')
    expect(await memory.get(PENDING_CONFIRMATION_KEY)).toBeUndefined()
    expect(await memory.get(DURABLE_FACTS_KEY)).toBeUndefined()
  })

  it('fires after the turn on the Nth user turn (never during it) and stages the op with evidence', async () => {
    process.env.AUDIT_MEMORY_REVIEWER = '1'
    process.env.AUDIT_MEMORY_REVIEWER_EVERY = '2'
    const { assistant, memory, calls } = build({ ops: [PREFERENCE_OP] })
    await assistant.turn('What is 1 plus 1?', { sessionId: 's' })
    await assistant.awaitMemoryReview()
    expect(calls).toEqual([])
    await assistant.turn('What is 2 plus 2?', { sessionId: 's' })
    await assistant.awaitMemoryReview()
    expect(calls).toEqual(['reviewer', 'verifier'])
    const pending = await pendingOf(memory)
    expect(pending).toHaveLength(1)
    expect(pending[0].evidence).toContain('Bullets please')
  })

  it('skips non-interactive turns', async () => {
    process.env.AUDIT_MEMORY_REVIEWER = '1'
    process.env.AUDIT_MEMORY_REVIEWER_EVERY = '1'
    const { assistant, calls } = build({ ops: [PREFERENCE_OP] })
    await assistant.turn('What is 1 plus 1?', { sessionId: 's', nonInteractive: true })
    await assistant.awaitMemoryReview()
    expect(calls).toEqual([])
  })

  it('runs at the session edge (/new) before the transcript is deleted', async () => {
    process.env.AUDIT_MEMORY_REVIEWER = '1'
    process.env.AUDIT_MEMORY_REVIEWER_EVERY = '50'
    const { assistant, memory, calls } = build({ ops: [PREFERENCE_OP] })
    await assistant.turn('What is 1 plus 1?', { sessionId: 's' })
    expect(calls).toEqual([])
    await assistant.clearSession('s')
    expect(calls).toEqual(['reviewer', 'verifier'])
    expect(await pendingOf(memory)).toHaveLength(1)
  })

  it('a new turn aborts an in-flight review', async () => {
    process.env.AUDIT_MEMORY_REVIEWER = '1'
    process.env.AUDIT_MEMORY_REVIEWER_EVERY = '1'
    const { assistant, memory } = build({ ops: [PREFERENCE_OP] })
    await assistant.turn('What is 1 plus 1?', { sessionId: 's' }) // starts a review (not awaited)
    const next = assistant.turn('What is 2 plus 2?', { sessionId: 's' }) // aborts it synchronously at turn start
    await next
    await assistant.awaitMemoryReview()
    // Whatever finished is whole: either nothing, or exactly one staged entry per run that completed; never a partial one.
    for (const p of await pendingOf(memory)) expect(p.evidence).toBeTruthy()
  })
})

describe('submitCandidate keyed supersession (audit)', () => {
  it('an auto-mode cross-turn durable write with the same key replaces the live entry instead of accumulating', async () => {
    const memory = new InMemoryAdapter()
    const llm = { async *callChat() { yield '' }, async callChatSync() { return '' }, async callChatStructured() { return { content: '{}' } } }
    const service = new MemoryService(memory, new InMemoryReminderStore(new InMemoryAdapter()), new InMemoryExperienceStore(), llm as never, () => undefined, () => '', undefined, () => 'auto')
    const base = { sourceTurn: 't', source: 'model_inferred' as const, durable: true, confidence: 'medium' as const, origin: 'user' as const, key: 'answer_style' }
    await service.submitCandidate('reviewer', { ...base, text: 'prefers long prose', extractedAt: '2026-01-01T00:00:00.000Z' }, 's')
    await service.submitCandidate('reviewer', { ...base, text: 'prefers bullet points', extractedAt: '2026-01-02T00:00:00.000Z' }, 's')
    const durable = (await memory.get('facts:durable')) as { text: string; supersedes?: string }[]
    expect(durable.map((f) => f.text)).toEqual(['prefers bullet points'])
    expect(durable[0].supersedes).toBe('prefers long prose')
    expect(((await memory.get('facts:retired')) as { text: string }[]).map((f) => f.text)).toEqual(['prefers long prose'])
  })
})
