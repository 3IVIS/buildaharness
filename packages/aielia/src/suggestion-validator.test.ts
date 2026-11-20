import { describe, it, expect } from 'vitest'
import { suggestionFromJSON, suggestionFingerprint, isNoopSuggestion, type HarnessSuggestion } from './harness-suggestion.js'
import { validateSuggestion, type ValidationContext } from './suggestion-validator.js'
import type { SurfaceSpec } from './harness-surfaces.js'

function good(over: Record<string, unknown> = {}): HarnessSuggestion {
  return suggestionFromJSON({
    id: 's1', tier: 2, surfaceId: 'layer:semantic_compaction', class: 'I', clusterSignature: 'c1',
    change: { kind: 'set', value: true }, whyNotNoop: 'long sessions overflow', regressionGuard: 'short sessions unchanged', expectedEffect: 'fewer overflows',
    expectedAffectedCases: ['a'], protectedCases: ['b'], expectedBeacon: 'layer_fired', evidenceRefs: ['run1'], status: 'proposed', ...over,
  })
}
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ resolveEvidenceRef: () => true, ...over })
const reasons = (s: HarnessSuggestion, c: ValidationContext = ctx()) => validateSuggestion(s, c).reasons

describe('suggestionFromJSON', () => {
  it('round-trips a good suggestion', () => {
    const s = good()
    expect(isNoopSuggestion(s)).toBe(false)
    expect(suggestionFromJSON(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })
  it.each([null, undefined, 42, 'x', [], {}, { surfaceId: 5, change: 'x' }, { surfaceId: 'a', change: { kind: 'set', value: { x: 1 } } }, { surfaceId: 'a', change: { kind: 'set', value: NaN } }, { surfaceId: '', change: { kind: 'set', value: true } }])(
    'degrades to a no-op on %j', (raw) => {
      const s = suggestionFromJSON(raw)
      expect(isNoopSuggestion(s)).toBe(true)
      expect(validateSuggestion(s, ctx()).reasons).toContain('noop')
    })
  it('falls back on unknown status, tier and class', () => {
    const s = good({ status: 'bogus', tier: 9, class: 'Z' })
    expect([s.status, s.tier, s.class]).toEqual(['proposed', 2, 'I'])
  })
  it('does not trust a supplied fingerprint, and ignores prose and references', () => {
    const a = good({ fingerprint: 'forged' })
    expect(a.fingerprint).not.toBe('forged')
    expect(good({ whyNotNoop: 'other words', change: { kind: 'set', value: true, references: ['x'] } }).fingerprint).toBe(a.fingerprint)
    expect(good({ change: { kind: 'set', value: false } }).fingerprint).not.toBe(a.fingerprint)
    expect(suggestionFingerprint('layer:x', { kind: 'set', value: true }, 'c')).toBe(suggestionFingerprint('layer:x', { kind: 'set', value: true }, 'c'))
  })
})

describe('validateSuggestion', () => {
  it('accepts a good suggestion', () => {
    expect(validateSuggestion(good(), ctx())).toEqual({ ok: true, reasons: [] })
  })
  it('unknown surface', () => {
    expect(reasons(good({ surfaceId: 'layer:nope' }))).toContain('unknown_surface')
    expect(reasons(good({ surfaceId: 'layer:control_state' }))).toContain('unknown_surface')
  })
  it('kernel surface (with a registered overlapping surface)', () => {
    const bad: SurfaceSpec = { id: 'file:k', class: 'E', path: 'packages/aielia/src/tool-policy.ts', scope: ['x'], valueSchema: { kind: 'string' }, beacon: { kind: 'slot_read' }, safetyRelevant: false, feedsCorrectionSignal: false }
    const s = good({ surfaceId: 'file:k', change: { kind: 'set', value: 'x' } })
    expect(reasons(s, ctx({ registry: [bad] }))).toContain('kernel_surface')
    expect(reasons(s, ctx({ registry: [{ ...bad, path: 'docs/ok.md' }] }))).not.toContain('kernel_surface')
    expect(reasons(s, ctx({ registry: [{ ...bad, path: 'docs/ok.md' }], kernelExtra: ['docs/'] }))).toContain('kernel_surface')
  })
  it('value shape', () => {
    expect(reasons(good({ change: { kind: 'set', value: 'yes' } }))).toContain('bad_value_shape')
  })
  it('no-op', () => {
    expect(reasons(good({ change: { kind: 'noop' } }))).toContain('noop')
  })
  it('already in force', () => {
    expect(reasons(good(), ctx({ choices: { semantic_compaction: true } }))).toContain('already_in_force')
    expect(reasons(good(), ctx({ choices: { semantic_compaction: false } }))).not.toContain('already_in_force')
  })
  it('operator-pinned flag', () => {
    expect(reasons(good(), ctx({ pinned: new Set(['semantic_compaction']), env: { AUDIT_SEMANTIC_COMPACTION: '0' } }))).toContain('operator_pinned')
    expect(reasons(good(), ctx({ pinned: new Set(['other']) }))).not.toContain('operator_pinned')
  })
  it('unmet requires', () => {
    const s = good({ surfaceId: 'layer:recall_tool' })
    expect(reasons(s, ctx({ choices: { episodic_digest: false } }))).toContain('unmet_requires')
    expect(reasons(s, ctx({ choices: { episodic_digest: true } }))).not.toContain('unmet_requires')
  })
  it('dismissed fingerprint', () => {
    const s = good()
    expect(reasons(s, ctx({ dismissedFingerprints: new Set([s.fingerprint]) }))).toContain('dismissed_fingerprint')
    expect(reasons(s, ctx({ dismissedFingerprints: new Set(['zz']) }))).not.toContain('dismissed_fingerprint')
  })
  it('reduction on a protected layer', () => {
    const s = good({ surfaceId: 'layer:semantic_grounding', change: { kind: 'set', value: false } })
    expect(reasons(s, ctx({ protectedLayers: new Set(['semantic_grounding']) }))).toContain('protected_layer_reduction')
    expect(reasons(s, ctx())).not.toContain('protected_layer_reduction')
  })
  it('capability needs beyond the grant', () => {
    const s = good({ capabilityNeeds: ['net'] })
    expect(reasons(s)).toContain('capability_beyond_grant')
    expect(reasons(s, ctx({ grant: new Set(['net']) }))).not.toContain('capability_beyond_grant')
  })
  it('edit-size cap', () => {
    expect(reasons(good(), ctx({ editSizeCap: 5 }))).toContain('edit_too_large')
    expect(reasons(good(), ctx({ editSizeCap: 500 }))).not.toContain('edit_too_large')
  })
  it('evidence refs that do not resolve', () => {
    expect(reasons(good(), ctx({ resolveEvidenceRef: (r) => r !== 'run1' }))).toContain('unresolved_evidence')
    expect(reasons(good(), {})).toContain('unresolved_evidence')
    expect(reasons(good({ evidenceRefs: [] }))).toContain('unresolved_evidence')
  })
  it('model-limited cluster', () => {
    expect(reasons(good(), ctx({ modelLimitedClusters: new Set(['c1']) }))).toContain('model_limited_cluster')
    expect(reasons(good(), ctx({ modelLimitedClusters: new Set(['c2']) }))).not.toContain('model_limited_cluster')
  })
  it('reference to a layer or setting that does not exist', () => {
    expect(reasons(good({ change: { kind: 'set', value: true, references: ['no_such_layer'] } }))).toContain('unknown_reference')
    expect(reasons(good({ change: { kind: 'set', value: true, references: ['supervisor', 'AUDIT_SEMANTIC_GROUNDING'] } }))).not.toContain('unknown_reference')
  })
  it('task-specific identifiers from the forbidden list', () => {
    const s = good({ whyNotNoop: 'fails on task hc-017 only' })
    expect(reasons(s, ctx({ forbiddenIds: ['hc-017'] }))).toContain('task_specific_identifier')
    expect(reasons(s, ctx({ forbiddenIds: ['hc-099'] }))).not.toContain('task_specific_identifier')
  })
  it('reports every reason, not only the first', () => {
    const r = reasons(good({ surfaceId: 'layer:nope', change: { kind: 'noop' }, evidenceRefs: [] }))
    expect(r).toEqual(expect.arrayContaining(['unknown_surface', 'noop', 'unresolved_evidence']))
  })
})
