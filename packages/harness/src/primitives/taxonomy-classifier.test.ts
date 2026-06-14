import { describe, it, expect, vi } from 'vitest'
import { TaxonomyClassifier, type ClassifierConfig } from './taxonomy-classifier.js'

const TAXONOMY = [
  { id: 'type_a', label: 'Type A', description: 'First category' },
  { id: 'type_b', label: 'Type B', description: 'Second category' },
  { id: 'type_fallback', label: 'Fallback', description: 'Default category' },
]

function makeConfig(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  return { taxonomy: TAXONOMY, fallbackTypeId: 'type_fallback', temperature: 0, ...overrides }
}

function makeLlmCall(response: string) {
  return vi.fn().mockResolvedValue(response)
}

function jsonResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    detected_types: ['type_a'],
    primary_type: 'type_a',
    confidence_scores: { type_a: 0.9 },
    rationale: 'test',
    ...overrides,
  })
}

describe('TaxonomyClassifier', () => {
  it('returns at least one detectedType for any non-empty input', async () => {
    const llm = makeLlmCall(jsonResponse())
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('some text')
    expect(result.detectedTypes.length).toBeGreaterThan(0)
  })

  it('primaryType always a valid taxonomy id', async () => {
    const llm = makeLlmCall(jsonResponse())
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('some text')
    expect(TAXONOMY.map((t) => t.id)).toContain(result.primaryType)
  })

  it('type IDs not in taxonomy stripped from response', async () => {
    const llm = makeLlmCall(
      jsonResponse({
        detected_types: ['type_a', 'invalid_id'],
        confidence_scores: { type_a: 0.9, invalid_id: 0.5 },
      }),
    )
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('some text')
    expect(result.detectedTypes).not.toContain('invalid_id')
    expect(result.confidenceScores).not.toHaveProperty('invalid_id')
  })

  it('llmCall throws: returns fallbackTypeId as primaryType, no exception propagated', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('LLM error'))
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('some text')
    expect(result.primaryType).toBe('type_fallback')
  })

  it('JSON parse error in llmCall response: returns fallback, no exception propagated', async () => {
    const llm = makeLlmCall('not json at all')
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('some text')
    expect(result.primaryType).toBe('type_fallback')
  })

  it('context included in prompt when contextStateKey is provided and key exists', async () => {
    const llm = makeLlmCall(jsonResponse())
    const c = new TaxonomyClassifier(makeConfig({ contextStateKey: 'ctx' }), llm)
    await c.classify('some text', { ctx: 'background info' })
    const prompt = llm.mock.calls[0][0] as string
    expect(prompt).toContain('background info')
  })

  it('temperature=0 passed to llmCall as third argument', async () => {
    const llm = makeLlmCall(jsonResponse())
    const c = new TaxonomyClassifier(makeConfig({ temperature: 0 }), llm)
    await c.classify('some text')
    expect(llm.mock.calls[0][2]).toBe(0)
  })

  it('empty input text: returns fallback without calling llmCall', async () => {
    const llm = makeLlmCall(jsonResponse())
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('')
    expect(result.primaryType).toBe('type_fallback')
    expect(llm).not.toHaveBeenCalled()
  })

  it('constructor: fallbackTypeId not present in taxonomy throws Error', () => {
    expect(
      () => new TaxonomyClassifier(makeConfig({ fallbackTypeId: 'nonexistent' }), vi.fn()),
    ).toThrow("fallbackTypeId 'nonexistent' is not in the taxonomy")
  })

  it('constructor: empty taxonomy array throws Error', () => {
    expect(
      () => new TaxonomyClassifier(makeConfig({ taxonomy: [] }), vi.fn()),
    ).toThrow('taxonomy must not be empty')
  })

  it('llmCall response missing confidenceScores → all detectedTypes default to 0.5', async () => {
    const llm = makeLlmCall(
      jsonResponse({ confidence_scores: {} }),
    )
    const c = new TaxonomyClassifier(makeConfig(), llm)
    const result = await c.classify('some text')
    for (const t of result.detectedTypes) {
      expect(result.confidenceScores[t]).toBe(0.5)
    }
  })

  it('contextStateKey set but key absent from context → prompt built without context, no exception', async () => {
    const llm = makeLlmCall(jsonResponse())
    const c = new TaxonomyClassifier(makeConfig({ contextStateKey: 'missing_key' }), llm)
    const result = await c.classify('some text', { other_key: 'value' })
    const prompt = llm.mock.calls[0][0] as string
    expect(prompt).not.toContain('Background context')
    expect(TAXONOMY.map((t) => t.id)).toContain(result.primaryType)
  })
})
