import { describe, it, expect } from 'vitest'
import { WorldModel } from '../state/world-model.js'
import { Diagnostics } from '../state/diagnostics.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { resolveControlState } from './resolve-control-state.js'
import type { ReviewerVerdict } from './reviewer-pass.js'

// Phase I — Reviewer Pass -> ControlState feedback (ADR-003 F-3, authority-map A-4).
// Mirrors adapter/tests/test_harness_i.py's INV-18 coverage.

function healthyDiagnostics(): Diagnostics {
  return new Diagnostics({
    belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
    coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
    verification_health: { strength: 0.8, feasibility: 0.8 },
    execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
    dep_class_gap_annotation: '',
  })
}

function verdict(severity: ReviewerVerdict['severity']): ReviewerVerdict {
  return { severity, lens: 'reviewer', summary: 'a finding' }
}

describe('resolveControlState — pendingReviewerVerdict (INV-18)', () => {
  it('MEDIUM severity forces CAUTIOUS and adds a note naming the lens', () => {
    const cs = resolveControlState(healthyDiagnostics(), new WorldModel(), new FailureDiagnostics(), undefined, verdict('MEDIUM'))
    expect(cs.execution_mode).toBe('CAUTIOUS')
    expect(cs.permission).toBe('ALLOW')
    expect(cs.notes.some(n => n.includes('Pending reviewer verdict') && n.includes('reviewer'))).toBe(true)
  })

  it('HIGH severity forces CAUTIOUS, never DENY', () => {
    const cs = resolveControlState(healthyDiagnostics(), new WorldModel(), new FailureDiagnostics(), undefined, verdict('HIGH'))
    expect(cs.execution_mode).toBe('CAUTIOUS')
    expect(cs.permission).toBe('ALLOW')
  })

  it('LOW severity does not force CAUTIOUS', () => {
    const cs = resolveControlState(healthyDiagnostics(), new WorldModel(), new FailureDiagnostics(), undefined, verdict('LOW'))
    expect(cs.execution_mode).toBe('NORMAL')
  })

  it('null/undefined verdict is a no-op', () => {
    const cs = resolveControlState(healthyDiagnostics(), new WorldModel(), new FailureDiagnostics(), undefined, null)
    expect(cs.execution_mode).toBe('NORMAL')
    expect(cs.notes).toEqual([])
  })

  it('never overrides TIER 1 SYSTEM_BREAKING (still DENY/RECOVERY, note still appended)', () => {
    const wm = new WorldModel({
      contradictions: [{ id: 'c1', description: 'x', severity: 'SYSTEM_BREAKING', involved_belief_ids: [], type: 'pairwise', scope: 'local' }],
    } as ConstructorParameters<typeof WorldModel>[0])
    const cs = resolveControlState(healthyDiagnostics(), wm, new FailureDiagnostics(), undefined, verdict('HIGH'))
    expect(cs.permission).toBe('DENY')
    expect(cs.execution_mode).toBe('RECOVERY')
    expect(cs.notes.some(n => n.includes('Pending reviewer verdict'))).toBe(true)
  })

  it('execution_mode is never NORMAL when a MEDIUM+ verdict is pending', () => {
    for (const severity of ['MEDIUM', 'HIGH'] as const) {
      const cs = resolveControlState(healthyDiagnostics(), new WorldModel(), new FailureDiagnostics(), undefined, verdict(severity))
      expect(cs.execution_mode).not.toBe('NORMAL')
    }
  })
})
