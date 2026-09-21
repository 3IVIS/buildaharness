import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import type { Belief } from '@buildaharness/harness'
import { checkSemanticCriterionCoverage, semanticCriterionCoverageEnabled, NON_CHECKABLE_DEFAULT_CRITERION } from './semantic-criterion-coverage.js'

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    this.receivedMessages.push(messages)
    return { content: this.content }
  }
}

class ThrowingLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    throw new Error('backend unreachable')
  }
}

function belief(id: string, statement: string): Belief {
  return { id, statement, confidence: 0.9, derived_from: [], recorded_at: '2026-07-25T00:00:00.000Z' }
}

describe('checkSemanticCriterionCoverage', () => {
  it('returns false without calling the LLM when there are no beliefs at all', async () => {
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const result = await checkSemanticCriterionCoverage('the login tests pass', [], llm)
    expect(result).toBe(false)
    expect(llm.calls).toBe(0)
  })

  it('calls the LLM and reports coverage for a paraphrased criterion', async () => {
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const result = await checkSemanticCriterionCoverage(
      'the login tests pass',
      [belief('b1', 'every authentication-related test in the suite is green')],
      llm,
    )
    expect(llm.calls).toBe(1)
    expect(result).toBe(true)
    const [sentMessages] = llm.receivedMessages
    const userMessage = sentMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userMessage).toContain('the login tests pass')
    expect(userMessage).toContain('authentication-related test')
  })

  it('returns false when the model reports no coverage', async () => {
    const llm = new StructuredOnlyLLMClient('{"covered":false}')
    const result = await checkSemanticCriterionCoverage('the login tests pass', [belief('b1', 'the weather is sunny today')], llm)
    expect(result).toBe(false)
  })

  it('returns false on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    const result = await checkSemanticCriterionCoverage('the login tests pass', [belief('b1', 'x')], llm)
    expect(result).toBe(false)
  })

  it('returns false when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    const result = await checkSemanticCriterionCoverage('the login tests pass', [belief('b1', 'x')], llm)
    expect(result).toBe(false)
  })

  it('returns false without calling the LLM for the ad hoc single-task turn default criterion, even with beliefs present', async () => {
    // This meta-instruction criterion isn't a factual claim any belief could ever state or
    // paraphrase — without this skip, every ordinary chat turn with at least one recorded belief
    // would spend a real LLM call here, forever, for a criterion that can never be "covered".
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const result = await checkSemanticCriterionCoverage(
      NON_CHECKABLE_DEFAULT_CRITERION,
      [belief('b1', 'the user lives in Berlin')],
      llm,
    )
    expect(result).toBe(false)
    expect(llm.calls).toBe(0)
  })
})

describe('semanticCriterionCoverageEnabled (AUDIT_SEMANTIC_CRITERION_COVERAGE gate — Phase C1)', () => {
  it('defaults ON when the flag is unset or empty', () => {
    expect(semanticCriterionCoverageEnabled({})).toBe(true)
    expect(semanticCriterionCoverageEnabled({ AUDIT_SEMANTIC_CRITERION_COVERAGE: '' })).toBe(true)
    expect(semanticCriterionCoverageEnabled({ AUDIT_SEMANTIC_CRITERION_COVERAGE: '  ' })).toBe(true)
  })

  it('stays ON for truthy values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', 'anything-else']) {
      expect(semanticCriterionCoverageEnabled({ AUDIT_SEMANTIC_CRITERION_COVERAGE: v }), v).toBe(true)
    }
  })

  it('turns OFF only for an explicit falsy value', () => {
    for (const v of ['0', 'false', 'off', 'no', 'disabled', 'DISABLED', ' Off ']) {
      expect(semanticCriterionCoverageEnabled({ AUDIT_SEMANTIC_CRITERION_COVERAGE: v }), v).toBe(false)
    }
  })

  it('when OFF, the criterionCoverageOff arm never reaches the LLM call; when ON, it is called once per unmatched criterion', async () => {
    // harness-bridge.ts gates the whole `semanticCriterionCoverage` hook on this helper, so an OFF
    // value means the harness's implementer lens sees `undefined` and runs its substring check
    // alone. Proven at the unit boundary, where the helper is the single decision point.
    const llm = new StructuredOnlyLLMClient('{"covered":true}')
    const beliefs = [belief('b1', 'the suite finished with zero failures')]
    const criteria = ['the login tests pass', 'the build is green']

    const offHook = semanticCriterionCoverageEnabled({ AUDIT_SEMANTIC_CRITERION_COVERAGE: '0' })
      ? (c: string, b: Belief[]) => checkSemanticCriterionCoverage(c, b, llm)
      : undefined
    for (const c of criteria) if (offHook) await offHook(c, beliefs)
    expect(llm.calls).toBe(0)

    const onHook = semanticCriterionCoverageEnabled({})
      ? (c: string, b: Belief[]) => checkSemanticCriterionCoverage(c, b, llm)
      : undefined
    for (const c of criteria) if (onHook) await onHook(c, beliefs)
    expect(llm.calls).toBe(2)
  })
})
