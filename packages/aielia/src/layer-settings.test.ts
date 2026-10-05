import { describe, it, expect } from 'vitest'
import { OPT_IN_FLAG } from '@buildaharness/harness'
import { LAYER_SETTINGS, applyLayerSettings, effectiveState, withLayerChoice, sanitizeLayerChoices, formatLayerListing, findLayer, LayerSettingError } from './layer-settings.js'
import { ESCALATION_ENV } from './layer-policy-wiring.js'
import { semanticHypothesesEnabled } from './semantic-hypotheses.js'
import { decompositionEnabled } from './turn-interpreter.js'

describe('registry', () => {
  it('uses the same flags as the harness opt-in table and the escalation env table', () => {
    for (const [layer, flag] of Object.entries(OPT_IN_FLAG)) expect(findLayer(layer)?.flag).toBe(flag)
    for (const [layer, flag] of Object.entries(ESCALATION_ENV)) expect(findLayer(layer)?.flag).toBe(flag)
  })
  it('has unique ids and flags, and locks every floor layer', () => {
    expect(new Set(LAYER_SETTINGS.map((l) => l.id)).size).toBe(LAYER_SETTINGS.length)
    const flags = LAYER_SETTINGS.flatMap((l) => (l.flag ? [l.flag] : []))
    expect(new Set(flags).size).toBe(flags.length)
    for (const l of LAYER_SETTINGS.filter((x) => x.group === 'floor')) expect(l.flag).toBeUndefined()
  })
})

describe('applyLayerSettings', () => {
  it('writes choices to the flags the layers read, so the real gates follow', () => {
    const env: Record<string, string | undefined> = {}
    expect(semanticHypothesesEnabled(env)).toBe(false)
    expect(decompositionEnabled(env)).toBe(true)
    applyLayerSettings({ semantic_hypotheses: true, decomposition_reframe: false }, env)
    expect(semanticHypothesesEnabled(env)).toBe(true)
    expect(decompositionEnabled(env)).toBe(false)
  })
  it('restores a flag it wrote when the choice is removed', () => {
    const env: Record<string, string | undefined> = {}
    applyLayerSettings({ semantic_hypotheses: true }, env)
    applyLayerSettings({}, env)
    expect(env.AUDIT_SEMANTIC_HYPOTHESES).toBeUndefined()
  })
  it('never overrides a flag the operator set, and reports it pinned', () => {
    const env: Record<string, string | undefined> = { AUDIT_DECOMPOSITION: '1' }
    const { pinned } = applyLayerSettings({ decomposition_reframe: false }, env)
    expect(env.AUDIT_DECOMPOSITION).toBe('1')
    expect(pinned.has('decomposition_reframe')).toBe(true)
    // still pinned on a re-apply, and an operator value that equals ours is not mistaken for ours
    expect(applyLayerSettings({}, env).pinned.has('decomposition_reframe')).toBe(true)
    expect(env.AUDIT_DECOMPOSITION).toBe('1')
  })
  it('ignores unknown and locked ids', () => {
    const env: Record<string, string | undefined> = {}
    applyLayerSettings({ approval_staging: false, nope: true }, env)
    expect(Object.keys(env)).toEqual([])
  })
})

describe('choices', () => {
  it('rejects locked and unknown layers with a readable error', () => {
    expect(() => withLayerChoice({}, 'approval_staging', false)).toThrow(LayerSettingError)
    expect(() => withLayerChoice({}, 'typo', true)).toThrow(/Unknown layer/)
  })
  it('sets and clears one choice without touching the others', () => {
    const a = withLayerChoice({ failure_match: false }, 'semantic_hypotheses', true)
    expect(a).toEqual({ failure_match: false, semantic_hypotheses: true })
    expect(withLayerChoice(a, 'failure_match', undefined)).toEqual({ semantic_hypotheses: true })
  })
  it('sanitizes a hand-edited persisted value', () => {
    expect(sanitizeLayerChoices({ failure_match: false, approval_staging: false, x: true, change_review: 'yes' })).toEqual({ failure_match: false })
    expect(sanitizeLayerChoices('junk')).toEqual({})
  })
  it('reports effective state: saved choice, else default, else the pinned env value', () => {
    const hyp = findLayer('semantic_hypotheses')!
    expect(effectiveState(hyp, undefined, new Set(), {})).toBe(false)
    expect(effectiveState(hyp, { semantic_hypotheses: true }, new Set(), {})).toBe(true)
    expect(effectiveState(hyp, { semantic_hypotheses: true }, new Set(['semantic_hypotheses']), { AUDIT_SEMANTIC_HYPOTHESES: '0' })).toBe(false)
  })
  it('lists every layer and marks floor layers locked', () => {
    const text = formatLayerListing({ semantic_hypotheses: true }, new Set(), {})
    for (const l of LAYER_SETTINGS) expect(text).toContain(l.id)
    expect(text).toMatch(/approval_staging\s+locked/)
    expect(text).toMatch(/semantic_hypotheses\s+on\s.*\(changed\)/)
  })
})
