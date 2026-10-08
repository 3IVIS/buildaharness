import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import { auditReply, replyAuditNotice, replyAuditEnabled, CLEAN_AUDIT } from './reply-audit.js'

class AuditLLM implements ILLMClient {
  seen: ChatMessage[][] = []
  constructor(private readonly content: string | Error) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
    this.seen.push(messages)
    if (this.content instanceof Error) throw this.content
    return { content: this.content }
  }
}
const base = { userMessage: 'fix that too', reply: 'Undone — the type hints were removed.', actions: [] as string[], sourcesRead: [] as string[], lookupUnavailable: false }

class SequenceLLM implements ILLMClient {
  calls = 0
  constructor(private readonly answers: string[]) {}
  async *callChat(): AsyncIterable<string> { yield '' }
  async callChatSync(): Promise<string> { return '' }
  async callChatStructured(): Promise<LLMStructuredResponse> { return { content: this.answers[Math.min(this.calls++, this.answers.length - 1)] } }
}
const FLAG_C = '{"claimsUnrecordedWork": true, "promisesWorkNotDone": false, "unverifiedOutsideFacts": false, "contradictsCommandOutput": false}'
const FLAG_U = '{"claimsUnrecordedWork": false, "promisesWorkNotDone": false, "unverifiedOutsideFacts": true, "contradictsCommandOutput": false}'
const NONE = '{"claimsUnrecordedWork": false, "promisesWorkNotDone": false, "unverifiedOutsideFacts": false, "contradictsCommandOutput": false}'

describe('reply audit', () => {
  it('returns a fresh object each time so a caller mutating a clean audit cannot poison later ones', async () => {
    const a = await auditReply(base, new AuditLLM(new Error('boom')))
    a.promisesWorkNotDone = true
    expect((await auditReply(base, new AuditLLM(new Error('boom')))).promisesWorkNotDone).toBe(false)
    expect(CLEAN_AUDIT.promisesWorkNotDone).toBe(false)
    const b = await auditReply({ ...base, reply: ' ' }, new AuditLLM('{}'))
    b.claimsUnrecordedWork = true
    expect(CLEAN_AUDIT.claimsUnrecordedWork).toBe(false)
  })
  it('asks two calls at once, a third only when they disagree, and keeps a category that at least two of the calls raise', async () => {
    const clean = new SequenceLLM([NONE, NONE, FLAG_C])
    expect(await auditReply(base, clean)).toEqual(CLEAN_AUDIT)
    expect(clean.calls).toBe(2)
    const agreed = new SequenceLLM([FLAG_C, FLAG_C, NONE])
    expect((await auditReply(base, agreed)).claimsUnrecordedWork).toBe(true)
    expect(agreed.calls).toBe(2)
    // One miss no longer lets a flagged reply through: the third call decides.
    const rescued = new SequenceLLM([NONE, FLAG_C, FLAG_C])
    expect((await auditReply(base, rescued)).claimsUnrecordedWork).toBe(true)
    expect(rescued.calls).toBe(3)
    const lone = new SequenceLLM([FLAG_C, NONE, NONE])
    expect(await auditReply(base, lone)).toEqual(CLEAN_AUDIT)
    expect(lone.calls).toBe(3)
    // Different categories from two calls: each needs a second vote of its own.
    expect(await auditReply(base, new SequenceLLM([FLAG_C, FLAG_U, NONE]))).toEqual(CLEAN_AUDIT)
    expect(await auditReply(base, new SequenceLLM([FLAG_C, FLAG_U, FLAG_C]))).toEqual({ ...CLEAN_AUDIT, claimsUnrecordedWork: true })
  })
  it('returns a clean audit when fewer than two of the first calls give a usable answer', async () => {
    class Flaky implements ILLMClient {
      calls = 0
      async *callChat(): AsyncIterable<string> { yield '' }
      async callChatSync(): Promise<string> { return '' }
      async callChatStructured(): Promise<LLMStructuredResponse> { if (this.calls++ === 0) throw new Error('timeout'); return { content: FLAG_C } }
    }
    expect(await auditReply(base, new Flaky())).toEqual(CLEAN_AUDIT)
  })
  it('passes what the system recorded to the model and reads the three flags', async () => {
    const llm = new AuditLLM('{"claimsUnrecordedWork": true, "promisesWorkNotDone": false, "unverifiedOutsideFacts": false}')
    const audit = await auditReply({ ...base, actions: ['wrote a.py'], lookupUnavailable: true }, llm)
    expect(audit).toEqual({ ...CLEAN_AUDIT, claimsUnrecordedWork: true })
    const payload = JSON.parse(String(llm.seen[0][1].content))
    expect(payload.actions).toEqual(['wrote a.py'])
    expect(payload.lookupUnavailable).toBe(true)
  })
  it('reads the flag for a reply that denies recorded work, and the flag for a reply that corrects itself, each kept only when at least two calls raise it (W1, U1)', async () => {
    const DENIES = '{"claimsUnrecordedWork": false, "promisesWorkNotDone": false, "unverifiedOutsideFacts": false, "contradictsCommandOutput": false, "contradictsRecordedWork": true, "leaksSelfCorrection": false}'
    const LEAKS = '{"claimsUnrecordedWork": false, "promisesWorkNotDone": false, "unverifiedOutsideFacts": false, "contradictsCommandOutput": false, "contradictsRecordedWork": false, "leaksSelfCorrection": true}'
    expect(await auditReply(base, new SequenceLLM([DENIES, DENIES]))).toEqual({ ...CLEAN_AUDIT, contradictsRecordedWork: true })
    expect(await auditReply(base, new SequenceLLM([LEAKS, LEAKS]))).toEqual({ ...CLEAN_AUDIT, leaksSelfCorrection: true })
    expect(await auditReply(base, new SequenceLLM([DENIES, NONE, NONE]))).toEqual(CLEAN_AUDIT)
    expect(await auditReply(base, new SequenceLLM([DENIES, LEAKS, NONE]))).toEqual(CLEAN_AUDIT)
  })
  it('gives the model every read of the session so far, so a statement about which tools were used can be checked (U1)', async () => {
    const llm = new AuditLLM(NONE)
    await auditReply({ ...base, sourcesRead: ['read_file: a.py'], earlierSourcesRead: ['list_directory: .', 'read_file: README.md'] }, llm)
    const payload = JSON.parse(String(llm.seen[0][1].content))
    expect(payload.sourcesRead).toEqual(['read_file: a.py'])
    expect(payload.earlierSourcesRead).toEqual(['list_directory: .', 'read_file: README.md'])
  })
  it('never flags a reply when the check fails or answers nonsense', async () => {
    expect(await auditReply(base, new AuditLLM(new Error('boom')))).toEqual(CLEAN_AUDIT)
    expect(await auditReply(base, new AuditLLM('not json'))).toEqual(CLEAN_AUDIT)
    expect(await auditReply({ ...base, reply: '  ' }, new AuditLLM('{}'))).toEqual(CLEAN_AUDIT)
  })
  it('builds one note from the flags, and none for a clean audit', () => {
    expect(replyAuditNotice(CLEAN_AUDIT, [])).toBeUndefined()
    const n = replyAuditNotice({ claimsUnrecordedWork: true, promisesWorkNotDone: true, unverifiedOutsideFacts: true, contradictsCommandOutput: true, contradictsRecordedWork: true, leaksSelfCorrection: true }, ['wrote a.py'])!
    expect(n).toContain('recorded: wrote a.py')
    expect(n).toContain('nothing was done this turn')
    expect(n).toContain('unverified')
    expect(n).toContain('denies or contradicts')
    expect(n).toContain('corrects itself')
    expect(replyAuditNotice({ ...CLEAN_AUDIT, claimsUnrecordedWork: true }, [])).toContain('recorded: nothing')
  })
  it('is on by default and off for falsy env values', () => {
    expect(replyAuditEnabled({})).toBe(true)
    expect(replyAuditEnabled({ AIELIA_REPLY_AUDIT: 'off' })).toBe(false)
    expect(replyAuditEnabled({ AIELIA_REPLY_AUDIT: '1' })).toBe(true)
  })
})
