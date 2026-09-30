import { describe, it, expect } from 'vitest'
import type { ChatMessage, ILLMClient, LLMStructuredResponse } from '@buildaharness/runtime'
import {
  semanticHypothesesEnabled,
  proposeCompetingExplanations,
  judgeHypothesesAgainstEvidence,
  renderHypothesisNote,
  hypothesisContextMessage,
  HYPOTHESIS_NOTE_PREFIX,
} from './semantic-hypotheses.js'

function client(content: string | (() => string), seen: ChatMessage[][] = []): ILLMClient {
  return {
    async *callChat() { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(messages: ChatMessage[]): Promise<LLMStructuredResponse> {
      seen.push(messages)
      return { content: typeof content === 'function' ? content() : content }
    },
  }
}

const two = {
  hypotheses: [
    { explanation: 'Soft-deleted rows are exported but hidden on the dashboard', predicted_observations: ['rows with deleted_at set'], separating_check: 'count deleted rows', confidence: 0.5 },
    { explanation: 'The dashboard refreshed before late rows arrived', predicted_observations: ['rows newer than the refresh'], separating_check: 'compare refresh time to max(created_at)', confidence: 0.5 },
  ],
}
const input = { request: 'why do the counts differ?', observations: [], beliefs: [] }

describe('semanticHypothesesEnabled (AUDIT_SEMANTIC_HYPOTHESES)', () => {
  it('is OFF unless a truthy value is set', () => {
    expect(semanticHypothesesEnabled({})).toBe(false)
    expect(semanticHypothesesEnabled({ AUDIT_SEMANTIC_HYPOTHESES: '' })).toBe(false)
    for (const v of ['0', 'false', 'off', 'no', 'disabled']) expect(semanticHypothesesEnabled({ AUDIT_SEMANTIC_HYPOTHESES: v }), v).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', ' ON ']) expect(semanticHypothesesEnabled({ AUDIT_SEMANTIC_HYPOTHESES: v }), v).toBe(true)
  })
})

describe('proposeCompetingExplanations', () => {
  it('parses two explanations with their predictions and separating checks, and sends the request', async () => {
    const seen: ChatMessage[][] = []
    const out = await proposeCompetingExplanations(input, client(JSON.stringify(two), seen))
    expect(out).toEqual([
      { explanation: 'Soft-deleted rows are exported but hidden on the dashboard', predicted_observations: ['rows with deleted_at set'], separating_check: 'count deleted rows', confidence: 0.5 },
      { explanation: 'The dashboard refreshed before late rows arrived', predicted_observations: ['rows newer than the refresh'], separating_check: 'compare refresh time to max(created_at)', confidence: 0.5 },
    ])
    expect(JSON.parse(seen[0].find((m) => m.role === 'user')!.content).request).toBe('why do the counts differ?')
  })

  it('one explanation is not a competition, and an empty list means the request is not underdetermined', async () => {
    expect(await proposeCompetingExplanations(input, client(JSON.stringify({ hypotheses: [two.hypotheses[0]] })))).toBeNull()
    expect(await proposeCompetingExplanations(input, client('{"hypotheses":[]}'))).toBeNull()
  })

  it('keeps at most four, skips blank explanations, and drops non-string predictions', async () => {
    const many = { hypotheses: [...Array(6)].map((_, i) => ({ explanation: `cause ${i}`, predicted_observations: ['a', 3, ' '] })).concat([{ explanation: '  ', predicted_observations: [] }] as never) }
    const out = await proposeCompetingExplanations(input, client(JSON.stringify(many)))
    expect(out?.map((h) => h.explanation)).toEqual(['cause 0', 'cause 1', 'cause 2', 'cause 3'])
    expect(out?.[0].predicted_observations).toEqual(['a'])
  })

  it('fails open on an error or an unusable answer, and tolerates a fenced reply', async () => {
    expect(await proposeCompetingExplanations(input, client(() => { throw new Error('boom') }))).toBeNull()
    expect(await proposeCompetingExplanations(input, client('not json'))).toBeNull()
    expect(await proposeCompetingExplanations(input, client('{"hypotheses":"nope"}'))).toBeNull()
    expect((await proposeCompetingExplanations(input, client('```json\n' + JSON.stringify(two) + '\n```')))?.length).toBe(2)
  })
})

describe('judgeHypothesesAgainstEvidence', () => {
  const hyps = [{ id: 'sem_0', explanation: 'a', predicted_observations: ['x'] }, { id: 'sem_1', explanation: 'b', predicted_observations: ['y'] }]

  it('returns what the evidence rules out, ignoring ids it was not given', async () => {
    const out = await judgeHypothesesAgainstEvidence({ hypotheses: hyps, observations: ['no rows are soft-deleted'] }, client('{"contradicted":[{"id":"sem_0","reason":"none deleted"},{"id":"ghost"}]}'))
    expect(out).toEqual({ contradicted: [{ id: 'sem_0', reason: 'none deleted' }] })
  })

  it('makes no call with nothing to judge, and fails open', async () => {
    const seen: ChatMessage[][] = []
    expect(await judgeHypothesesAgainstEvidence({ hypotheses: [], observations: ['o'] }, client('{}', seen))).toBeNull()
    expect(await judgeHypothesesAgainstEvidence({ hypotheses: hyps, observations: [] }, client('{}', seen))).toBeNull()
    expect(seen).toHaveLength(0)
    expect(await judgeHypothesesAgainstEvidence({ hypotheses: hyps, observations: ['o'] }, client(() => { throw new Error('boom') }))).toBeNull()
    expect(await judgeHypothesesAgainstEvidence({ hypotheses: hyps, observations: ['o'] }, client('garbage'))).toBeNull()
  })
})

describe('the proposer-facing note', () => {
  it('lists each explanation with what to expect and how to tell it apart, behind a recognisable prefix', () => {
    const note = renderHypothesisNote([{ explanation: 'cause A', predicted_observations: ['x', 'y'], separating_check: 'check A' }, { explanation: 'cause B', predicted_observations: [] }])
    expect(note.startsWith(HYPOTHESIS_NOTE_PREFIX)).toBe(true)
    expect(note).toContain('- cause A (you would expect: x; y — to tell it apart: check A)')
    expect(note).toContain('- cause B')
  })

  it('the context message tells the model not to assert one unless the evidence rules the others out', () => {
    const msg = hypothesisContextMessage('- cause A')
    expect(msg).toContain('do not assert one as the answer')
    expect(msg).toContain('- cause A')
  })
})
