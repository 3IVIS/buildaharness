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

describe('reply audit', () => {
  it('passes what the system recorded to the model and reads the three flags', async () => {
    const llm = new AuditLLM('{"claimsUnrecordedWork": true, "promisesWorkNotDone": false, "unverifiedOutsideFacts": false}')
    const audit = await auditReply({ ...base, actions: ['wrote a.py'], lookupUnavailable: true }, llm)
    expect(audit).toEqual({ claimsUnrecordedWork: true, promisesWorkNotDone: false, unverifiedOutsideFacts: false })
    const payload = JSON.parse(String(llm.seen[0][1].content))
    expect(payload.actions).toEqual(['wrote a.py'])
    expect(payload.lookupUnavailable).toBe(true)
  })
  it('never flags a reply when the check fails or answers nonsense', async () => {
    expect(await auditReply(base, new AuditLLM(new Error('boom')))).toEqual(CLEAN_AUDIT)
    expect(await auditReply(base, new AuditLLM('not json'))).toEqual(CLEAN_AUDIT)
    expect(await auditReply({ ...base, reply: '  ' }, new AuditLLM('{}'))).toEqual(CLEAN_AUDIT)
  })
  it('builds one note from the flags, and none for a clean audit', () => {
    expect(replyAuditNotice(CLEAN_AUDIT, [])).toBeUndefined()
    const n = replyAuditNotice({ claimsUnrecordedWork: true, promisesWorkNotDone: true, unverifiedOutsideFacts: true }, ['wrote a.py'])!
    expect(n).toContain('recorded: wrote a.py')
    expect(n).toContain('nothing was done this turn')
    expect(n).toContain('unverified')
    expect(replyAuditNotice({ ...CLEAN_AUDIT, claimsUnrecordedWork: true }, [])).toContain('recorded: nothing')
  })
  it('is on by default and off for falsy env values', () => {
    expect(replyAuditEnabled({})).toBe(true)
    expect(replyAuditEnabled({ AIELIA_REPLY_AUDIT: 'off' })).toBe(false)
    expect(replyAuditEnabled({ AIELIA_REPLY_AUDIT: '1' })).toBe(true)
  })
})
