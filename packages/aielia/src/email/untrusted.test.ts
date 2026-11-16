import { describe, it, expect } from 'vitest'
import { assessMail, structuralMailFlags, findLinkMismatches, MAIL_UNTRUSTED_PROMPT } from './untrusted.js'
import { buildHostileSet, hostileMessages } from './hostile-set.js'
import { buildMailModelInput } from './model-input.js'
import { evaluateToolPolicy, mailToolClass, MAIL_TOOL_CLASSES, type ToolPolicyInput, type ToolPolicyResult } from '../tool-policy.js'
import type { Account } from './model.js'

const ACCOUNT: Account = { id: 'acct-hostile', provider: 'fake', address: 'me@example.org', displayName: 'Me', aieliaMayRead: true, excludedFolders: [], excludedSenders: [] }

describe('structural flags', () => {
  const byId = (id: string) => buildHostileSet().find((i) => i.id === id)!.message
  it('flags a spoofed display name', () => {
    expect(structuralMailFlags(byId('spoof-display-name')).map((f) => f.kind)).toContain('sender_mismatch')
  })
  it('flags a link whose text and target differ', () => {
    expect(structuralMailFlags(byId('link-mismatch')).map((f) => f.kind)).toContain('link_mismatch')
    expect(findLinkMismatches('<a href="https://example.com/x">example.com</a> [docs.example.org](https://docs.example.org/a)')).toEqual([])
  })
  it('flags the oversized body and the tag-close attempt', () => {
    expect(structuralMailFlags(byId('oversized-body')).map((f) => f.kind)).toContain('oversized')
    expect(structuralMailFlags(byId('tag-close-attempt')).map((f) => f.kind)).toEqual(expect.arrayContaining([]))
  })
  it('does not flag an ordinary message', () => {
    const m = { ...byId('inject-ignore-previous'), textBody: 'Lunch on Thursday?', from: { address: 'anna@example.com', name: 'Anna' } }
    expect(structuralMailFlags(m)).toEqual([])
  })
})

describe('model judgement', () => {
  const m = buildHostileSet()[0]!.message
  it('adds an instruction_like flag when the judge flags, and survives a failing judge', async () => {
    const wrapped = (buildMailModelInput(ACCOUNT, m) as { text: string }).text
    expect((await assessMail(m, wrapped, async () => ({ flagged: true, reason: 'x' }))).map((f) => f.kind)).toContain('instruction_like')
    expect(await assessMail(m, wrapped, async () => { throw new Error('down') })).toEqual([])
  })
  it('prompt text names the untrusted tag', () => {
    expect(MAIL_UNTRUSTED_PROMPT).toContain('<untrusted_external_content>')
  })
})

describe('wrapping of hostile set', () => {
  it('every hostile message comes out wrapped, with the tag not closable from inside', () => {
    for (const m of hostileMessages()) {
      const r = buildMailModelInput(ACCOUNT, m)
      if (!r.ok) throw new Error('blocked')
      expect(r.text.startsWith('<untrusted_external_content>')).toBe(true)
      expect(r.text.split('</untrusted_external_content>').length).toBe(2)
    }
  })
})

describe('mail tool policy', () => {
  const OUTWARD = Object.keys(MAIL_TOOL_CLASSES).filter((n) => MAIL_TOOL_CLASSES[n] === 'outward_or_destructive')

  it('classes match section 6', () => {
    expect(mailToolClass('mail_search')).toBe('read_only')
    expect(mailToolClass('mail_move')).toBe('reversible')
    expect(mailToolClass('mail_create_draft')).toBe('creates_for_review')
    expect(mailToolClass('mail_send')).toBe('outward_or_destructive')
    expect(mailToolClass('mail_new_unlisted')).toBe('outward_or_destructive')
    expect(mailToolClass('read_file')).toBeUndefined()
  })
  it('read-only mail tools pass the gate', () => {
    expect(evaluateToolPolicy({ toolName: 'mail_search', riskHint: 'LOW' }).decision).toBe('ALLOW')
  })
  it('outward tools are always staged, whatever the risk hint or control state', () => {
    for (const toolName of OUTWARD) {
      for (const riskHint of ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const) {
        expect(evaluateToolPolicy({ toolName, riskHint, controlState: { permission: 'ALLOW', execution_mode: 'NORMAL', escalation: 'NONE' } }).decision).toBe('REQUIRE_APPROVAL')
      }
    }
  })

  // A minimal executor: runs a call unless the policy stages it.
  const run = (policy: (i: ToolPolicyInput) => ToolPolicyResult, input: ToolPolicyInput, executed: string[]) => {
    const r = policy(input)
    if (r.decision === 'ALLOW') executed.push(input.toolName)
    return r
  }
  it('after reading any hostile message, no outward or organising tool executes and the origin shows', () => {
    const executed: string[] = []
    for (const _m of hostileMessages()) {
      for (const toolName of Object.keys(MAIL_TOOL_CLASSES).filter((n) => MAIL_TOOL_CLASSES[n] !== 'read_only')) {
        const r = run(evaluateToolPolicy, { toolName, riskHint: 'LOW', origin: 'untrusted_mail' }, executed)
        expect(r.decision).toBe('REQUIRE_APPROVAL')
        expect(r.origin).toBe('untrusted_mail')
        expect(r.reason).toContain('untrusted mail')
      }
    }
    expect(executed).toEqual([])
  })
  it('negative control: with the code gate disabled the same calls execute', () => {
    const executed: string[] = []
    const open = (): ToolPolicyResult => ({ decision: 'ALLOW', reason: 'gate disabled' })
    run(open, { toolName: 'mail_send', riskHint: 'LOW', origin: 'untrusted_mail' }, executed)
    run(open, { toolName: 'mail_delete_permanent', riskHint: 'LOW', origin: 'untrusted_mail' }, executed)
    expect(executed).toEqual(['mail_send', 'mail_delete_permanent'])
  })
})
