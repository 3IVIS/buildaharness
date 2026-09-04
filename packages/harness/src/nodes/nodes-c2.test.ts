import { describe, it, expect } from 'vitest'
import { classifyRecovery } from '../recovery-policy.js'
import { RECOVERY_CLASSIFICATION_TABLE } from '../_core-generated.js'
import { verify } from './verify.js'
import { WorldModel, type Belief } from '../state/world-model.js'

// Phase C2 (plans/harness_consolidation_and_control_plane_plan.html;
// docs/adr/004-shared-semantic-core.md) — additive shared-core fields, mirrors
// adapter/tests/test_harness_c2.py.

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
