import { describe, it, expect } from 'vitest'
import { classifyRecovery } from '../recovery-policy.js'
import { RECOVERY_CLASSIFICATION_TABLE, MODEL_PROVENANCE_NOTE_PREFIX } from '../_core-generated.js'
import { verify } from './verify.js'
import { WorldModel, type Belief } from '../state/world-model.js'
import { Diagnostics } from '../state/diagnostics.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { resolveControlState } from './resolve-control-state.js'

// Phase C2 (harness consolidation plan; ADR-004, shared semantic core) —
// additive shared-core fields, mirrors adapter/tests/test_harness_c2.py.

describe('C2 — recovery classification -> policy table (criticism002 #7)', () => {
  it('a known failure class short-circuits to its policy + action', () => {
    expect(classifyRecovery('timeout')).toEqual({
      failure_class: 'timeout',
      policy: 'retry_with_backoff',
      action: 'execution_retry',
    })
  })

  it('an unclassified failure returns null (caller falls through to strategy order)', () => {
    expect(classifyRecovery(null)).toBeNull()
    expect(classifyRecovery(undefined)).toBeNull()
    expect(classifyRecovery('')).toBeNull()
    expect(classifyRecovery('not_a_known_failure_mode')).toBeNull()
  })

  it('every table row round-trips through classifyRecovery', () => {
    for (const [failureClass, entry] of Object.entries(RECOVERY_CLASSIFICATION_TABLE)) {
      expect(classifyRecovery(failureClass)).toEqual({
        failure_class: failureClass,
        policy: entry.policy,
        action: entry.action,
      })
    }
  })

  it('the generated table is byte-identical in shape to what Python consumes', () => {
    // Guards against the two runtimes drifting on the table (both read _core / _core-generated).
    expect(Object.keys(RECOVERY_CLASSIFICATION_TABLE).sort()).toEqual(
      [
        'approval_required',
        'contradiction',
        'insufficient_context',
        'missing_evidence',
        'no_progress',
        'permission_denied',
        'stall',
        'system_breaking',
        'timeout',
        'tool_unreliable',
        'transient_tool_error',
        'unsafe_state',
      ].sort(),
    )
  })
})

describe('C2 — VerificationResult.critical_failure_tiers (INV-12)', () => {
  it('INV-12: critical_failure_tiers is non-empty iff has_critical_failure', () => {
    // A plain verify() with no evidence store FAILs evidence_sufficiency (environmental tier).
    const failing = verify({ ok: true }, [], [], null, 'LOW')
    expect(failing.has_critical_failure).toBe(true)
    expect(failing.critical_failure_tiers.length).toBeGreaterThan(0)

    // Add a SYSTEM_BREAKING contradiction → consistency (mechanical tier) also FAILs.
    const wm = new WorldModel({ contradictions: [{ id: 'c1', severity: 'SYSTEM_BREAKING' } as never] })
    const both = verify({ ok: true }, [], [], null, 'LOW', null, wm)
    expect(both.has_critical_failure).toBe(true)
    expect(both.critical_failure_tiers).toContain('mechanical')
    // de-duplicated + sorted
    expect([...both.critical_failure_tiers].sort()).toEqual(both.critical_failure_tiers)
    expect(new Set(both.critical_failure_tiers).size).toBe(both.critical_failure_tiers.length)
  })
})

describe('C2 — Diagnostics.provenance (INV-11)', () => {
  const sub10 = [
    'belief_freshness', 'belief_consistency', 'belief_support',
    'symptom_coverage', 'explanation_coverage',
    'verification_strength', 'verification_feasibility',
    'progress_rate', 'failure_recurrence', 'oscillation_score',
  ]

  it('INV-11: every sub-dimension has a provenance entry after resolveControlState', () => {
    const d = new Diagnostics()
    expect(d.provenance).toEqual({})
    resolveControlState(d, new WorldModel(), new FailureDiagnostics())
    for (const name of sub10) {
      expect(d.provenance[name]).toBeDefined()
      expect(d.provenance[name].source).toBe('deterministic')
    }
  })

  it('an explicit provenance entry is not overwritten by the fill', () => {
    const d = new Diagnostics()
    d.provenance.belief_support = { source: 'model', calibrated: true, evidence_ids: ['e1'] }
    resolveControlState(d, new WorldModel(), new FailureDiagnostics())
    expect(d.provenance.belief_support).toEqual({ source: 'model', calibrated: true, evidence_ids: ['e1'] })
  })

  it('an uncalibrated model-derived value that drives a Tier-2 block is annotated in notes[]', () => {
    const d = new Diagnostics({ belief_health: { freshness: 1, consistency: 1, support: 0.05 } })
    d.provenance.belief_support = { source: 'model', calibrated: false, evidence_ids: [] }
    const cs = resolveControlState(d, new WorldModel(), new FailureDiagnostics())
    expect(cs.permission).toBe('DENY')
    expect(cs.notes).toContain(`${MODEL_PROVENANCE_NOTE_PREFIX}belief_support`)
  })

  it('a calibrated model block, or a deterministic block, is NOT annotated', () => {
    for (const p of [
      { source: 'model' as const, calibrated: true, evidence_ids: [] },
      { source: 'deterministic' as const, calibrated: false, evidence_ids: [] },
    ]) {
      const d = new Diagnostics({ belief_health: { freshness: 1, consistency: 1, support: 0.05 } })
      d.provenance.belief_support = p
      const cs = resolveControlState(d, new WorldModel(), new FailureDiagnostics())
      expect(cs.permission).toBe('DENY')
      expect(cs.notes.some(n => n.startsWith(MODEL_PROVENANCE_NOTE_PREFIX))).toBe(false)
    }
  })
})

describe('C2 — belief-model parity (criticism00 H8)', () => {
  it('addBelief rejects an empty derived_from[] chain (matches Python)', () => {
    const wm = new WorldModel()
    const belief: Belief = {
      id: 'b1',
      statement: 'x',
      confidence: 0.5,
      derived_from: [],
      recorded_at: new Date().toISOString(),
    }
    expect(() => wm.addBelief(belief)).toThrow(/non-empty derived_from/)
  })

  it('addBelief is append-only — existing entries are never removed', () => {
    const wm = new WorldModel()
    const mk = (id: string): Belief => ({
      id,
      statement: id,
      confidence: 0.5,
      derived_from: ['obs-1'],
      recorded_at: new Date().toISOString(),
    })
    wm.addBelief(mk('b1'))
    wm.addBelief(mk('b2'))
    expect(wm.beliefs.map(b => b.id)).toEqual(['b1', 'b2'])
  })
})
