import { describe, it, expect } from 'vitest'
import { explainInputFromEntries } from './explain-input'
import type { ChatEntry } from './types'

describe('explainInputFromEntries', () => {
  it('is empty before any turn', () => {
    expect(explainInputFromEntries([])).toEqual({ memoryInjection: undefined, planStatus: undefined })
  })

  it('explains the newest assistant reply, skipping user messages and earlier explanations', () => {
    const entries: ChatEntry[] = [
      { id: '1', kind: 'assistant', content: 'old', sources: [{ tool: 'read_file', path: 'old.md' }] as never },
      { id: '2', kind: 'assistant', content: 'new', sources: [{ tool: 'read_file', path: 'new.md' }] as never },
      { id: '3', kind: 'explain', command: '/why', lines: ['x'] },
      { id: '4', kind: 'user', content: '/sources' },
    ]
    expect(explainInputFromEntries(entries).sources).toEqual([{ tool: 'read_file', path: 'new.md' }])
  })

  it('gives a specific no-trace reason for a turn that ended before the harness ran', () => {
    const approval: ChatEntry = { id: '1', kind: 'approval', pendingMessage: 'rm', reason: 'r', resolution: 'denied' }
    expect(explainInputFromEntries([approval]).noTraceReason).toContain('declined')
    expect(explainInputFromEntries([{ ...approval, resolution: undefined }]).noTraceReason).toContain('waiting for your approval')
    expect(explainInputFromEntries([{ id: '2', kind: 'escalation', reason: 'stuck', pendingMessage: 'm' }]).noTraceReason).toContain('stuck')
  })

  it('prefers the live plan status over the one captured on the reply', () => {
    const entries: ChatEntry[] = [{ id: '1', kind: 'assistant', content: 'a', planStatus: { completionPct: 10 } as never }]
    expect(explainInputFromEntries(entries, { planStatus: { completionPct: 90 } as never }).planStatus?.completionPct).toBe(90)
  })
})
