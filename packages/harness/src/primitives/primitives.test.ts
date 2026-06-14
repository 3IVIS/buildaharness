import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeBlend, makeBlendAdjuster, type BlendRule } from './blend-engine.js'
import { makeTurnInitializer, type SessionField, type ResourceBudget } from './turn-context.js'
import { makePreferenceExtractor, type PreferenceSignal } from './preference-extractor.js'
import { jaccardSimilarity, makeMultiSourceReducer, type BranchConfig } from './multi-source-reducer.js'

// ─── G-1: StrategyBlendEngine ─────────────────────────────────────────────

describe('normalizeBlend', () => {
  it('output always sums to exactly 100', () => {
    const result = normalizeBlend({ blend_a: 30, blend_b: 70 })
    const total = Object.values(result).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(100, 10)
  })

  it('negative inputs floored to 0 before normalisation', () => {
    const result = normalizeBlend({ blend_a: -20, blend_b: 80 })
    // blend_a floored to 0, blend_b = 80 → scale to 100
    expect(result['blend_a']).toBe(0)
    expect(result['blend_b']).toBeCloseTo(100, 10)
  })

  it('all-zero input returns the input unchanged (cannot normalise a zero-sum blend)', () => {
    const input = { blend_a: 0, blend_b: 0 }
    const result = normalizeBlend(input)
    expect(Object.is(result, input)).toBe(true)
  })
})

describe('makeBlendAdjuster', () => {
  const alwaysFire: BlendRule = {
    condition: () => true,
    adjustments: { blend_a: -5 },
  }

  it('non-matching rule not applied', () => {
    const rule: BlendRule = { condition: () => false, adjustments: { blend_a: -20 } }
    const adjuster = makeBlendAdjuster([rule])
    const state = { strategy_blend: { blend_a: 60, blend_b: 40 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    expect(blend['blend_a']).toBeCloseTo(60, 10)
  })

  it('result blend always sums to 100', () => {
    const rule: BlendRule = { condition: () => true, adjustments: { blend_a: -7, blend_b: 3 } }
    const adjuster = makeBlendAdjuster([rule])
    const state = { strategy_blend: { blend_a: 50, blend_b: 30, blend_c: 20 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    const total = Object.values(blend).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(100, 10)
  })

  it('no single key changes by more than momentumCap in one call', () => {
    const rule: BlendRule = { condition: () => true, adjustments: { blend_a: -50 } }
    const adjuster = makeBlendAdjuster([rule], 'strategy_blend', 10)
    const state = { strategy_blend: { blend_a: 60, blend_b: 40 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    // blend_a originally 60; capped change = -10 → 50 before normalise
    // after normalise: 50/90 * 100 ≈ 55.55, so change from 60 is within 10 after normalise
    // but the pre-normalise cap ensures delta ≤ 10
    const original = (state['strategy_blend'] as Record<string, number>)['blend_a']
    expect(Math.abs(blend['blend_a'] - original)).toBeLessThanOrEqual(10 + 1e-9)
  })

  it('redistributeTo receives freed weight proportionally', () => {
    const rule: BlendRule = {
      condition: () => true,
      adjustments: { blend_a: -5 },
      redistributeTo: ['blend_b', 'blend_c'],
    }
    // Use momentumCap=30 so no capping interferes
    const adjuster = makeBlendAdjuster([rule], 'strategy_blend', 30)
    const state = { strategy_blend: { blend_a: 60, blend_b: 30, blend_c: 10 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    // freed = 5, total target = 40, b gets 5*(30/40)=3.75, c gets 5*(10/40)=1.25
    // total stays 100 → no normalise change
    expect(blend['blend_b']).toBeCloseTo(33.75, 5)
    expect(blend['blend_c']).toBeCloseTo(11.25, 5)
    // ratio of increase: b_increase / c_increase ≈ 3
    expect((blend['blend_b'] - 30) / (blend['blend_c'] - 10)).toBeCloseTo(3, 5)
  })

  it('styleOverride written when rule fires', () => {
    const rule: BlendRule = {
      condition: () => true,
      adjustments: {},
      styleOverride: 'direct',
    }
    const adjuster = makeBlendAdjuster([rule])
    const result = adjuster({ strategy_blend: { blend_a: 100 } })
    expect(result['style_override']).toBe('direct')
  })

  it('styleOverride NOT written when rule does not fire', () => {
    const rule: BlendRule = {
      condition: () => false,
      adjustments: {},
      styleOverride: 'direct',
    }
    const adjuster = makeBlendAdjuster([rule])
    const result = adjuster({ strategy_blend: { blend_a: 100 } })
    expect('style_override' in result).toBe(false)
  })

  it('key cannot go below 0 after adjustment', () => {
    const rule: BlendRule = { condition: () => true, adjustments: { blend_a: -200 } }
    const adjuster = makeBlendAdjuster([rule], 'strategy_blend', 200)
    const state = { strategy_blend: { blend_a: 50, blend_b: 50 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    expect(blend['blend_a']).toBeGreaterThanOrEqual(0)
  })

  it('multiple rules firing in same call all apply within momentum cap', () => {
    const rules: BlendRule[] = [
      { condition: () => true, adjustments: { blend_a: -8 } },
      { condition: () => true, adjustments: { blend_a: -8 } },
    ]
    const adjuster = makeBlendAdjuster(rules, 'strategy_blend', 10)
    const state = { strategy_blend: { blend_a: 60, blend_b: 40 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    const original = (state['strategy_blend'] as Record<string, number>)['blend_a']
    // Both rules fire: total adjustment = -16, but cap = 10
    expect(original - blend['blend_a']).toBeLessThanOrEqual(10 + 1e-9)
  })

  it('when all adjustment-target keys are already 0, freed weight is 0 and blend is unchanged', () => {
    const rule: BlendRule = {
      condition: () => true,
      adjustments: { blend_a: -10 },
      redistributeTo: ['blend_b'],
    }
    const adjuster = makeBlendAdjuster([rule], 'strategy_blend', 20)
    const state = { strategy_blend: { blend_a: 0, blend_b: 50, blend_c: 50 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    // blend_a was 0, -10 → still 0, freed = 0 → no redistribution
    expect(blend['blend_a']).toBeCloseTo(0, 10)
    expect(blend['blend_b']).toBeCloseTo(50, 10)
    expect(blend['blend_c']).toBeCloseTo(50, 10)
  })

  it('blendKey absent from state returns same state reference unchanged (Object.is)', () => {
    const adjuster = makeBlendAdjuster([alwaysFire])
    const state = { some_other_key: 42 }
    const result = adjuster(state)
    expect(Object.is(result, state)).toBe(true)
  })

  it('adjustment keys not present in the blend are silently ignored; present keys still updated', () => {
    const rule: BlendRule = {
      condition: () => true,
      adjustments: { nonexistent_key: -50, blend_a: -5 },
    }
    const adjuster = makeBlendAdjuster([rule], 'strategy_blend', 20)
    const state = { strategy_blend: { blend_a: 60, blend_b: 40 } }
    const result = adjuster(state)
    const blend = result['strategy_blend'] as Record<string, number>
    // nonexistent_key silently skipped; blend_a updated
    expect('nonexistent_key' in blend).toBe(false)
    expect(blend['blend_a']).toBeLessThan(60)
  })

  it('empty rules list returns state with blend normalised but otherwise unchanged', () => {
    const adjuster = makeBlendAdjuster([])
    const state = { strategy_blend: { blend_a: 30, blend_b: 70 }, extra: 'value' }
    const result = adjuster(state)
    expect(result['extra']).toBe('value')
    expect('style_override' in result).toBe(false)
    const blend = result['strategy_blend'] as Record<string, number>
    const total = Object.values(blend).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(100, 10)
  })
})

// ─── G-2: TurnContextBootstrap ─────────────────────────────────────────────

describe('makeTurnInitializer — sourcePath resolution', () => {
  it('nested dot-path reads correctly', () => {
    const fields: SessionField[] = [{ key: 'x', default: 'fallback', sourcePath: 'outer.inner' }]
    const init = makeTurnInitializer(fields)
    const result = init({ outer: { inner: 'deep-value' }, turn_number: 1 })
    expect(result['x']).toBe('deep-value')
  })

  it('missing path falls back to field.default', () => {
    const fields: SessionField[] = [{ key: 'x', default: 'fallback', sourcePath: 'outer.missing' }]
    const init = makeTurnInitializer(fields)
    const result = init({ outer: {} })
    expect(result['x']).toBe('fallback')
  })

  it('intermediate key exists but resolves to null → falls back to field.default', () => {
    const fields: SessionField[] = [{ key: 'x', default: 'fallback', sourcePath: 'outer.inner' }]
    const init = makeTurnInitializer(fields)
    const result = init({ outer: { inner: null } })
    expect(result['x']).toBe('fallback')
  })
})

describe('makeTurnInitializer — initOnce', () => {
  it('initOnce=true: field not overwritten on turn 2+', () => {
    const fields: SessionField[] = [
      { key: 'x', default: 'seed', sourcePath: 'src_x', initOnce: true },
    ]
    const init = makeTurnInitializer(fields)
    // Turn 1: write from sourcePath
    const state1 = init({ src_x: 'turn1-value', turn_number: 1 })
    expect(state1['x']).toBe('turn1-value')
    // Turn 2: initOnce → skip update, preserve turn-1 value
    const state2 = init({ ...state1, src_x: 'turn2-value', turn_number: 2 })
    expect(state2['x']).toBe('turn1-value')
  })

  it('initOnce=false (default): field written every turn from sourcePath', () => {
    const fields: SessionField[] = [
      { key: 'x', default: 'seed', sourcePath: 'src_x', initOnce: false },
    ]
    const init = makeTurnInitializer(fields)
    const state1 = init({ src_x: 'v1', turn_number: 1 })
    expect(state1['x']).toBe('v1')
    const state2 = init({ ...state1, src_x: 'v2', turn_number: 2 })
    expect(state2['x']).toBe('v2')
  })
})

describe('makeTurnInitializer — no sourcePath', () => {
  it('field written only if key absent from state', () => {
    const fields: SessionField[] = [{ key: 'x', default: 'default-val' }]
    const init = makeTurnInitializer(fields)
    // Key absent: write default
    const r1 = init({})
    expect(r1['x']).toBe('default-val')
    // Key present: do not overwrite
    const r2 = init({ x: 'existing' })
    expect(r2['x']).toBe('existing')
  })
})

describe('makeTurnInitializer — resourceBudget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turn 1: all required keys initialised (timeLimitSeconds, tokenBudget, elapsedSeconds, tokensUsed, startedAt)', () => {
    const budget: ResourceBudget = { timeLimitSeconds: 60, tokenBudget: 1000 }
    const init = makeTurnInitializer([], { resourceBudget: budget })
    const result = init({ turn_number: 1 })
    const b = result['resource_budget'] as Record<string, unknown>
    expect(b['timeLimitSeconds']).toBe(60)
    expect(b['tokenBudget']).toBe(1000)
    expect(b['elapsedSeconds']).toBe(0)
    expect(b['tokensUsed']).toBe(0)
    expect(b['startedAt']).toBeInstanceOf(Date)
  })

  it('turn 2+: elapsedSeconds updated from startedAt using fake timers; timeLimitSeconds and tokenBudget preserved', () => {
    vi.useFakeTimers()
    const start = new Date('2024-01-01T00:00:00.000Z')
    vi.setSystemTime(start)

    const budget: ResourceBudget = { timeLimitSeconds: 60, tokenBudget: 1000 }
    const init = makeTurnInitializer([], { resourceBudget: budget })

    // Turn 1
    const state1 = init({ turn_number: 1 })

    // Advance 5 seconds
    vi.advanceTimersByTime(5000)

    // Turn 2
    const state2 = init({ ...state1, turn_number: 2 })
    const b = state2['resource_budget'] as Record<string, unknown>
    expect(b['elapsedSeconds']).toBeCloseTo(5, 1)
    expect(b['timeLimitSeconds']).toBe(60)
    expect(b['tokenBudget']).toBe(1000)
  })

  it('turnKey absent from state → treated as turn 1, budget initialised with all required keys', () => {
    const budget: ResourceBudget = { timeLimitSeconds: 30, tokenBudget: 500 }
    const init = makeTurnInitializer([], { resourceBudget: budget })
    // No turn_number in state → isTurnOne = true
    const result = init({})
    const b = result['resource_budget'] as Record<string, unknown>
    expect(b['timeLimitSeconds']).toBe(30)
    expect(b['elapsedSeconds']).toBe(0)
    expect(b['startedAt']).toBeInstanceOf(Date)
  })

  it('startedAt missing from existing budget on turn 2+ → elapsedSeconds set to 0, no throw', () => {
    const budget: ResourceBudget = { timeLimitSeconds: 60, tokenBudget: 1000 }
    const init = makeTurnInitializer([], { resourceBudget: budget })
    // Simulate a state where budget exists but startedAt is missing
    const state = {
      turn_number: 2,
      resource_budget: { timeLimitSeconds: 60, tokenBudget: 1000, tokensUsed: 0 },
    }
    expect(() => {
      const result = init(state)
      const b = result['resource_budget'] as Record<string, unknown>
      expect(b['elapsedSeconds']).toBe(0)
    }).not.toThrow()
  })
})

describe('makeTurnInitializer — emptyModelKey', () => {
  it('seeded with deep clone of template when state key is falsy', () => {
    const template = { field_x: [], nested: { field_y: 0 } }
    const init = makeTurnInitializer([], {
      emptyModelKey: 'my_model',
      emptyModelTemplate: template,
    })
    const result = init({})
    const model = result['my_model'] as typeof template
    expect(model).toEqual(template)
    // Verify it is a deep clone (not the same reference)
    expect(Object.is(model, template)).toBe(false)
    model.nested.field_y = 99
    expect(template.nested.field_y).toBe(0)
  })

  it('not overwritten when state key already truthy', () => {
    const init = makeTurnInitializer([], {
      emptyModelKey: 'my_model',
      emptyModelTemplate: { field_x: [] },
    })
    const result = init({ my_model: { field_x: ['existing'] } })
    const model = result['my_model'] as Record<string, unknown>
    expect(model['field_x']).toEqual(['existing'])
  })
})

describe('makeTurnInitializer — composition and edge cases', () => {
  it('all three mechanisms compose correctly in one call', () => {
    const fields: SessionField[] = [
      { key: 'field_a', default: 'none', sourcePath: 'source.a' },
    ]
    const budget: ResourceBudget = { timeLimitSeconds: 45, tokenBudget: 750 }
    const init = makeTurnInitializer(fields, {
      resourceBudget: budget,
      emptyModelKey: 'model_x',
      emptyModelTemplate: { items: [] },
    })
    const state = {
      turn_number: 1,
      source: { a: 'hello' },
    }
    const result = init(state)
    // Fields: sourcePath resolved
    expect(result['field_a']).toBe('hello')
    // ResourceBudget: initialised
    const b = result['resource_budget'] as Record<string, unknown>
    expect(b['timeLimitSeconds']).toBe(45)
    // EmptyModel: seeded
    expect(result['model_x']).toEqual({ items: [] })
  })

  it('all params empty/undefined → returns new object identical in content to input', () => {
    const init = makeTurnInitializer([])
    const state = { field_a: 1, field_b: 'hello' }
    const result = init(state)
    expect(Object.is(result, state)).toBe(false)
    expect(result).toEqual(state)
  })
})

// ─── G-3: FeedbackPreferenceExtractor ────────────────────────────────────────

describe('makePreferenceExtractor', () => {
  it('empty inputKey: same state reference returned unchanged (Object.is), processedFlagKey absent', () => {
    const extract = makePreferenceExtractor([])
    const state: Record<string, unknown> = { other_key: 'value' }
    const result = extract(state)
    expect(Object.is(result, state)).toBe(true)
    expect('feedback_processed' in result).toBe(false)
  })

  it('value signal: matching pattern writes correct field→value to outputKey', () => {
    const signals: PreferenceSignal[] = [{ patterns: ['concise'], field: 'field_x', value: 'short' }]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'please be concise' })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe('short')
  })

  it('delta signal: numeric delta applied correctly to current state value', () => {
    const signals: PreferenceSignal[] = [{ patterns: ['more'], field: 'field_x', delta: 5 }]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'give me more', field_x: 10 })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe(15)
  })

  it('delta signal: result clamped to minValue', () => {
    const signals: PreferenceSignal[] = [
      { patterns: ['less'], field: 'field_x', delta: -20, minValue: 0 },
    ]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'much less', field_x: 5 })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe(0)
  })

  it('delta signal: result clamped to maxValue', () => {
    const signals: PreferenceSignal[] = [
      { patterns: ['more'], field: 'field_x', delta: 20, maxValue: 10 },
    ]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'more please', field_x: 5 })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe(10)
  })

  it('delta signal: result at exactly minValue boundary equals minValue; at maxValue boundary equals maxValue', () => {
    const signals: PreferenceSignal[] = [
      { patterns: ['adjust'], field: 'field_x', delta: -5, minValue: 5, maxValue: 15 },
    ]
    const extract = makePreferenceExtractor(signals)
    // At minValue boundary: 10 - 5 = 5 → exactly minValue
    const r1 = extract({ feedback_text: 'adjust', field_x: 10 })
    expect((r1['preference_updates'] as Record<string, unknown>)['field_x']).toBe(5)
    // At maxValue boundary: use a positive delta
    const signals2: PreferenceSignal[] = [
      { patterns: ['adjust'], field: 'field_x', delta: 5, minValue: 5, maxValue: 15 },
    ]
    const extract2 = makePreferenceExtractor(signals2)
    const r2 = extract2({ feedback_text: 'adjust', field_x: 10 })
    expect((r2['preference_updates'] as Record<string, unknown>)['field_x']).toBe(15)
  })

  it('multiple matching signals produce multiple entries in outputKey', () => {
    const signals: PreferenceSignal[] = [
      { patterns: ['concise'], field: 'field_x', value: 'short' },
      { patterns: ['formal'], field: 'field_y', value: 'professional' },
    ]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'please be concise and formal' })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe('short')
    expect(updates['field_y']).toBe('professional')
  })

  it('unmatched feedback: empty outputKey dict written, no error', () => {
    const signals: PreferenceSignal[] = [{ patterns: ['never-matches'], field: 'field_x', value: 1 }]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'something unrelated' })
    expect(result['preference_updates']).toEqual({})
    expect(result['feedback_processed']).toBe(true)
  })

  it('pattern matching is case-insensitive', () => {
    const signals: PreferenceSignal[] = [{ patterns: ['CONCISE'], field: 'field_x', value: 'short' }]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'please be concise' })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe('short')
  })

  it('processedFlagKey written true after any non-empty feedback (even if no signals matched)', () => {
    const extract = makePreferenceExtractor([])
    const result = extract({ feedback_text: 'anything at all' })
    expect(result['feedback_processed']).toBe(true)
  })

  it('signal with both value and delta non-null throws Error at factory construction time', () => {
    expect(() => {
      makePreferenceExtractor([{ patterns: ['x'], field: 'field_x', value: 1, delta: 2 }])
    }).toThrow('PreferenceSignal: value and delta are mutually exclusive')
  })

  it('delta signal: field absent from state, base value defaults to 0 before delta is applied', () => {
    const signals: PreferenceSignal[] = [{ patterns: ['more'], field: 'field_x', delta: 3 }]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'more please' })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe(3)
  })

  it('two signals targeting the same field: the last matching signal in the list writes the final value', () => {
    const signals: PreferenceSignal[] = [
      { patterns: ['good'], field: 'field_x', value: 'first' },
      { patterns: ['good'], field: 'field_x', value: 'last' },
    ]
    const extract = makePreferenceExtractor(signals)
    const result = extract({ feedback_text: 'this is good' })
    const updates = result['preference_updates'] as Record<string, unknown>
    expect(updates['field_x']).toBe('last')
  })
})

// ─── G-4: MultiSourceDiversityReducer ────────────────────────────────────────

type Item = Record<string, unknown>
const textFn = (item: unknown): string => (item as Item)['text'] as string

describe('jaccardSimilarity', () => {
  it('two identical single-word texts → 1.0; two completely disjoint texts → 0.0', () => {
    expect(jaccardSimilarity('hello', 'hello')).toBe(1.0)
    expect(jaccardSimilarity('hello', 'world')).toBe(0.0)
  })
})

describe('makeMultiSourceReducer', () => {
  it('items from all non-empty branches collected and tagged with source and reliability', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'MEDIUM' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    const result = reducer([
      { source_1: [{ text: 'item alpha' }] },
      { source_2: [{ text: 'item beta' }] },
    ])
    const items = result['items'] as Item[]
    expect(items).toHaveLength(2)
    expect(items.find((i) => i['source'] === 'src_1')?.['reliability']).toBe('HIGH')
    expect(items.find((i) => i['source'] === 'src_2')?.['reliability']).toBe('MEDIUM')
  })

  it('empty / null branch stateKey skipped without error', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    expect(() => reducer([{ source_1: null as unknown as unknown[] }])).not.toThrow()
    const result = reducer([{ source_1: null as unknown as unknown[] }])
    expect(result['items']).toEqual([])
  })

  it('near-duplicate items (above similarityThreshold) deduplicated to one', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, {
      similarityThreshold: 0.5,
      minDiversityCount: 1,
    })
    const result = reducer([
      { source_1: [{ text: 'the quick brown fox' }] },
      { source_2: [{ text: 'the quick brown fox' }] },
    ])
    expect((result['items'] as Item[]).length).toBe(1)
  })

  it('deduplication keeps item with higher reliability rank', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'LOW' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, {
      similarityThreshold: 0.5,
      minDiversityCount: 1,
    })
    const result = reducer([
      { source_1: [{ text: 'the quick brown fox' }] },
      { source_2: [{ text: 'the quick brown fox' }] },
    ])
    const items = result['items'] as Item[]
    expect(items).toHaveLength(1)
    expect(items[0]['reliability']).toBe('HIGH')
  })

  it('below-threshold items from different sources both survive', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, {
      similarityThreshold: 0.85,
      minDiversityCount: 1,
    })
    const result = reducer([
      { source_1: [{ text: 'apples are red fruit' }] },
      { source_2: [{ text: 'bananas are yellow' }] },
    ])
    expect((result['items'] as Item[]).length).toBe(2)
  })

  it('diversityWarning true when fewer than minDiversityCount items survive', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 3 })
    const result = reducer([{ source_1: [{ text: 'only one item' }] }])
    expect(result['diversity_warning']).toBe(true)
  })

  it('diversityWarning false when enough distinct items survive', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 2 })
    const result = reducer([
      { source_1: [{ text: 'item alpha one' }, { text: 'item beta two' }] },
    ])
    expect(result['diversity_warning']).toBe(false)
  })

  it('internalOnly flag set on all items from branches with internalOnly=true', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH', internalOnly: true },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    const result = reducer([{ source_1: [{ text: 'internal item' }] }])
    const items = result['items'] as Item[]
    expect(items[0]['internal_only']).toBe(true)
  })

  it('reliabilityFn overrides static reliability per item', () => {
    const branches: BranchConfig[] = [
      {
        stateKey: 'source_1',
        sourceLabel: 'src_1',
        reliability: 'LOW',
        reliabilityFn: () => 'HIGH',
      },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    const result = reducer([{ source_1: [{ text: 'item a' }] }])
    const items = result['items'] as Item[]
    expect(items[0]['reliability']).toBe('HIGH')
  })

  it('all-empty branches: empty output, diversityWarning true', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    const result = reducer([{ source_1: [] }, { source_2: [] }])
    expect(result['items']).toEqual([])
    expect(result['diversity_warning']).toBe(true)
  })

  it('two near-duplicate items with equal reliability from different branches: item from lower-index branch retained', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, {
      similarityThreshold: 0.5,
      minDiversityCount: 1,
    })
    const result = reducer([
      { source_1: [{ text: 'the quick brown fox' }] },
      { source_2: [{ text: 'the quick brown fox' }] },
    ])
    const items = result['items'] as Item[]
    expect(items).toHaveLength(1)
    expect(items[0]['source']).toBe('src_1')
  })

  it('itemTextFn returns empty string: item has similarity 0.0 to all others and is never deduplicated', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
    ]
    const alwaysEmpty = (_item: unknown): string => ''
    const reducer = makeMultiSourceReducer(branches, alwaysEmpty, {
      similarityThreshold: 0.5,
      minDiversityCount: 1,
    })
    const result = reducer([
      { source_1: [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }] },
    ])
    expect((result['items'] as Item[]).length).toBe(3)
  })

  it('len(branchStates) < len(branches): extra branch configs skipped, result contains only available states', () => {
    const branches: BranchConfig[] = [
      { stateKey: 'source_1', sourceLabel: 'src_1', reliability: 'HIGH' },
      { stateKey: 'source_2', sourceLabel: 'src_2', reliability: 'HIGH' },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    // Only one branch state provided, second branch config should be skipped
    const result = reducer([{ source_1: [{ text: 'only from first branch' }] }])
    const items = result['items'] as Item[]
    expect(items).toHaveLength(1)
    expect(items[0]['source']).toBe('src_1')
  })

  it('reliabilityFn that throws for a specific item: exception propagates', () => {
    const branches: BranchConfig[] = [
      {
        stateKey: 'source_1',
        sourceLabel: 'src_1',
        reliability: 'HIGH',
        reliabilityFn: (item) => {
          if ((item as Item)['bad']) throw new Error('reliabilityFn error')
          return 'HIGH'
        },
      },
    ]
    const reducer = makeMultiSourceReducer(branches, textFn, { minDiversityCount: 1 })
    expect(() => reducer([{ source_1: [{ text: 'item', bad: true }] }])).toThrow(
      'reliabilityFn error',
    )
  })
})
