import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { validatePlanTaskGraph, verifyPlanDraft } from './plan-verification.js'
import type { PlanTaskRecord } from './plan-store.js'

function task(id: string, depends_on: string[] = []): PlanTaskRecord {
  return { id, description: `Task ${id}`, depends_on, status: 'PENDING', riskLevel: 'LOW' }
}

class ScriptedVerifyLLMClient implements ILLMClient {
  calls = 0
  constructor(private readonly respond: () => LLMStructuredResponse) {}

  async *callChat(): AsyncIterable<string> {
    throw new Error('callChat should never be reached by verifyPlanDraft')
  }
  async callChatSync(): Promise<string> {
    throw new Error('callChatSync should never be reached by verifyPlanDraft')
  }
  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    return this.respond()
  }
}

describe('validatePlanTaskGraph (P6 deterministic checks)', () => {
  it('returns no errors for a valid, acyclic, fully-referenced task list', () => {
    const errors = validatePlanTaskGraph([task('a'), task('b', ['a']), task('c', ['b'])])
    expect(errors).toEqual([])
  })

  it('flags a dangling depends_on reference', () => {
    const errors = validatePlanTaskGraph([task('a', ['does-not-exist'])])
    expect(errors.some((e) => e.includes('does-not-exist'))).toBe(true)
  })

  it('flags a dependency cycle', () => {
    const errors = validatePlanTaskGraph([task('a', ['b']), task('b', ['a'])])
    expect(errors.some((e) => /cycle/i.test(e))).toBe(true)
  })

  it('flags a duplicate task id', () => {
    const errors = validatePlanTaskGraph([task('a'), task('a')])
    expect(errors.some((e) => /duplicate/i.test(e))).toBe(true)
  })

  it('reports all errors found, not just the first', () => {
    const errors = validatePlanTaskGraph([task('a', ['missing']), task('a')])
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('verifyPlanDraft (P6 self-verification pass)', () => {
  it('fails fast on a graph error without ever calling the LLM', async () => {
    const llm = new ScriptedVerifyLLMClient(() => {
      throw new Error('should not be called when the graph is invalid')
    })
    const outcome = await verifyPlanDraft(llm, [task('a', ['b']), task('b', ['a'])], 'Ship it.', 'Because it works.')
    expect(outcome.kind).toBe('graph_invalid')
    expect(llm.calls).toBe(0)
    if (outcome.kind === 'graph_invalid') {
      expect(outcome.errors.some((e) => /cycle/i.test(e))).toBe(true)
    }
  })

  it('LLM-failure fallback: a verification-call failure still verifies the plan, just without reviewNotes', async () => {
    const llm = new ScriptedVerifyLLMClient(() => {
      throw new Error('LLM backend unavailable')
    })
    const outcome = await verifyPlanDraft(llm, [task('a')], 'Ship it.', 'Because it works.')
    expect(outcome.kind).toBe('verified')
    if (outcome.kind === 'verified') {
      expect(outcome.reviewNotes).toEqual([])
      expect(typeof outcome.verifiedAt).toBe('string')
    }
  })

  it('LLM-failure fallback: malformed JSON from the review call also falls back to no reviewNotes, not an error', async () => {
    const llm = new ScriptedVerifyLLMClient(() => ({ content: 'not valid json' }))
    const outcome = await verifyPlanDraft(llm, [task('a')], 'Ship it.', 'Because it works.')
    expect(outcome.kind).toBe('verified')
    if (outcome.kind === 'verified') expect(outcome.reviewNotes).toEqual([])
  })

  it('a deliberately incomplete draft is flagged in reviewNotes by a scripted mock verifier', async () => {
    const llm = new ScriptedVerifyLLMClient(() => ({
      content: JSON.stringify({
        findings: ['The success criteria mentions deployment, but no task deploys anything.'],
      }),
    }))
    const outcome = await verifyPlanDraft(llm, [task('write_code')], 'The feature is deployed to production.', 'Ship the feature.')
    expect(outcome.kind).toBe('verified')
    if (outcome.kind === 'verified') {
      expect(outcome.reviewNotes).toEqual(['The success criteria mentions deployment, but no task deploys anything.'])
    }
    expect(llm.calls).toBe(1)
  })

  it('a complete draft with no findings passes verification with empty reviewNotes', async () => {
    const llm = new ScriptedVerifyLLMClient(() => ({ content: JSON.stringify({ findings: [] }) }))
    const outcome = await verifyPlanDraft(llm, [task('a'), task('b', ['a'])], 'Ship it.', 'Because it works.')
    expect(outcome.kind).toBe('verified')
    if (outcome.kind === 'verified') expect(outcome.reviewNotes).toEqual([])
  })
})
