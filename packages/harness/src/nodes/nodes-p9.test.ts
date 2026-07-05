import { describe, it, expect } from 'vitest'
import { WorldModel } from '../state/world-model.js'
import { Diagnostics } from '../state/diagnostics.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { CallerState } from '../state/caller-state.js'
import { ControlState } from '../state/control-state.js'
import { TaskGraph } from '../state/task-graph.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { EvidenceStore } from '../state/evidence-store.js'
import { NormalisationError } from '../normalise.js'
import { computeElevationFactor } from '../generation-id.js'

import { resolveControlState } from './resolve-control-state.js'
import {
  checkCallerUpdates,
  NoOpUpdateChannel,
  RESTART_ITERATION,
  type UpdateChannel,
  type ConstraintPropagationContext,
} from './check-caller-updates.js'
import { updateTaskGraph, GraphCycleError } from './update-task-graph.js'
import { selectTask, reconcileParallelBranches } from './select-task.js'
import { estimateRisk, type RiskableAction } from './estimate-risk.js'
import { estimateVOI } from './estimate-voi.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function healthyDiagnostics(): Diagnostics {
  return new Diagnostics({
    belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
    coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
    verification_health: { strength: 0.8, feasibility: 0.8 },
    // failure_recurrence and oscillation_score are inverted in resolveControlState (0=healthy)
    execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
    dep_class_gap_annotation: '',
  })
}

function makeTask(overrides: Partial<{
  id: string
  description: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'BLOCKED' | 'HUMAN_REQUIRED'
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH'
  depends_on: string[]
  parallel_write_domains: string[]
  abstraction_level: number
  assigned_strategy: string | null
}> = {}) {
  return {
    id: overrides.id ?? 't1',
    description: overrides.description ?? 'a task',
    status: overrides.status ?? 'PENDING',
    risk_level: overrides.risk_level ?? 'MEDIUM',
    depends_on: overrides.depends_on ?? [],
    parallel_write_domains: overrides.parallel_write_domains ?? [],
    abstraction_level: overrides.abstraction_level ?? 1,
    assigned_strategy: overrides.assigned_strategy ?? null,
  }
}

const NOW = new Date().toISOString()

// ─── resolve_control_state ────────────────────────────────────────────────────

describe('resolve_control_state', () => {
  it('TIER 1 fires on SYSTEM_BREAKING contradiction → BLOCKED returned; TIER 2+ not evaluated', () => {
    const wm = new WorldModel({ generation_id: 3 })
    wm.contradictions.push({
      id: 'c1', type: 'pairwise', severity: 'SYSTEM_BREAKING',
      scope: 'global', description: 'fatal conflict', involved_belief_ids: [],
    })
    const cs = resolveControlState(healthyDiagnostics(), wm, new FailureDiagnostics())

    expect(cs.risk_state).toBe('BLOCKED')
    expect(cs.escalation_reason).toBe('SYSTEM_BREAKING_CONTRADICTION')
    // TIER 1 adds world_model_integrity block
    expect(cs.block_mask.some(e => e.dimension === 'world_model_integrity')).toBe(true)
  })

  it('TIER 2 adds dimension action_class to block_mask when sub-dim < 0.2 (CRITICAL_THRESHOLD)', () => {
    const wm = new WorldModel({ generation_id: 1 })
    const diag = new Diagnostics({
      belief_health: { freshness: 0.1, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    expect(cs.block_mask.some(e => e.dimension === 'belief_freshness')).toBe(true)
  })

  it('single blocked dimension is NOT a deadlock (RECOVERY_ACTION_DEPENDENCIES cross-dimension)', () => {
    const wm = new WorldModel({ generation_id: 1 })
    const diag = new Diagnostics({
      belief_health: { freshness: 0.1, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    expect(cs.escalation_reason).not.toBe('HUMAN_REQUIRED')
    expect(cs.block_mask).toHaveLength(1)
  })

  it('multiple blocked dimensions produce multiple BlockEntries; no deadlock when deps not mutually blocked', () => {
    const wm = new WorldModel({ generation_id: 1 })
    // symptom_coverage, explanation_coverage, verification_strength all below CRITICAL_THRESHOLD
    const diag = new Diagnostics({
      belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.1, explanation_coverage: 0.1 },
      verification_health: { strength: 0.1, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    expect(cs.block_mask.length).toBeGreaterThan(1)
    expect(cs.escalation_reason).not.toBe('HUMAN_REQUIRED')
    expect(cs.risk_state).toBe('BLOCKED')
  })

  it('TIER 3 fires on low symptom_coverage even when TIER 2 not triggered', () => {
    const wm = new WorldModel({ generation_id: 1 })
    const diag = new Diagnostics({
      belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.3, explanation_coverage: 0.6 }, // 0.3 < HIGH_THRESHOLD (0.5)
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    expect(cs.risk_state).toBe('CAUTIOUS')
    expect(cs.block_mask).toHaveLength(0)
  })

  it('conflict rule in TIER 3 allows exploration actions that do not require blocked dimension', () => {
    const wm = new WorldModel({ generation_id: 1 })
    const diag = new Diagnostics({
      belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.3, explanation_coverage: 0.6 },
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    // TIER 3 fired (CAUTIOUS) but TIER 2 did not — block_mask is empty
    expect(cs.risk_state).toBe('CAUTIOUS')
    expect(cs.block_mask).toHaveLength(0)
  })

  it('TIER 4 proportional caution elevation via compute_elevation_factor() callable in isolation', () => {
    const factor = computeElevationFactor([0.1, 0.2, 0.8])
    expect(factor).toBeGreaterThan(0)
    expect(factor).toBeLessThanOrEqual(1)

    const wm = new WorldModel({ generation_id: 1 })
    const diag = new Diagnostics({
      belief_health: { freshness: 0.3, consistency: 0.3, support: 0.8 }, // two below CAUTION_THRESHOLD
      coverage_health: { symptom_coverage: 0.6, explanation_coverage: 0.5 },
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    expect(cs.risk_state).toBe('CAUTIOUS')
  })

  it('TIER 5 returns NORMAL when all signals are above their respective thresholds', () => {
    const wm = new WorldModel({ generation_id: 2 })
    const cs = resolveControlState(healthyDiagnostics(), wm, new FailureDiagnostics())

    expect(cs.risk_state).toBe('NORMAL')
    expect(cs.escalation_reason).toBeNull()
    expect(cs.block_mask).toHaveLength(0)
  })

  it('dep_class_gap_annotation attached to control_state.notes[] as string only; not evaluated in any tier', () => {
    const wm = new WorldModel({ generation_id: 1 })
    const annotation = 'Abstraction class gaps detected: gap between level 0 and 2'
    const diag = new Diagnostics({
      belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: annotation,
    })
    const cs = resolveControlState(diag, wm, new FailureDiagnostics())

    expect(cs.notes.some(n => n.includes('dep_class_gap'))).toBe(true)
    expect(cs.risk_state).toBe('NORMAL') // annotation does not trigger any tier
    expect(cs.block_mask).toHaveLength(0)
  })

  it('generation_id stamped to worldModel.generation_id after resolution completes', () => {
    const wm = new WorldModel({ generation_id: 7 })
    const cs = resolveControlState(healthyDiagnostics(), wm, new FailureDiagnostics())

    expect(cs.generation_id).toBe(7)
  })

  it('assertNormalised() called on all inputs at entry; throws NormalisationError on out-of-range value', () => {
    const wm = new WorldModel({ generation_id: 1 })
    const diag = new Diagnostics({
      belief_health: { freshness: 1.5, consistency: 0.8, support: 0.8 }, // 1.5 out of [0,1]
      coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
      verification_health: { strength: 0.8, feasibility: 0.8 },
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })

    expect(() => resolveControlState(diag, wm, new FailureDiagnostics())).toThrow(NormalisationError)
  })
})

// ─── check_caller_updates ─────────────────────────────────────────────────────

describe('check_caller_updates', () => {
  it('NoOpUpdateChannel returns empty list (default no-op)', () => {
    const cs = new CallerState()
    const result = checkCallerUpdates(cs, new NoOpUpdateChannel())

    expect(result).toBe('NO_UPDATE')
    expect(cs.constraints_changed).toBe(false)
  })

  it('constraint update triggers applyConstraintChangePropagation() — same shared function as escalation path', () => {
    const cs = new CallerState()
    const wm = new WorldModel({ generation_id: 0 })
    const ctx: ConstraintPropagationContext = {
      worldModel: wm,
      hypothesisSet: new HypothesisSet(),
      taskGraph: new TaskGraph(),
      diagnostics: healthyDiagnostics(),
      failureDiagnostics: new FailureDiagnostics(),
    }
    const channel: UpdateChannel = {
      poll: () => ({ pending_update: { timeout: 30 }, constraints_changed: true }),
    }

    checkCallerUpdates(cs, channel, ctx)

    // applyConstraintChangePropagation increments worldModel.generation_id (observable side-effect)
    expect(wm.generation_id).toBe(1)
  })

  it('reset_constraints_changed() called after propagation to prevent re-trigger', () => {
    const cs = new CallerState()
    const wm = new WorldModel({ generation_id: 0 })
    const ctx: ConstraintPropagationContext = {
      worldModel: wm,
      hypothesisSet: new HypothesisSet(),
      taskGraph: new TaskGraph(),
      diagnostics: healthyDiagnostics(),
      failureDiagnostics: new FailureDiagnostics(),
    }
    const channel: UpdateChannel = {
      poll: () => ({ pending_update: { key: 'val' }, constraints_changed: true }),
    }

    checkCallerUpdates(cs, channel, ctx)

    expect(cs.constraints_changed).toBe(false)
  })

  it('iteration restarts via RESTART_ITERATION signal after constraint propagation', () => {
    const cs = new CallerState()
    const wm = new WorldModel({ generation_id: 0 })
    const ctx: ConstraintPropagationContext = {
      worldModel: wm,
      hypothesisSet: new HypothesisSet(),
      taskGraph: new TaskGraph(),
      diagnostics: healthyDiagnostics(),
      failureDiagnostics: new FailureDiagnostics(),
    }
    const channel: UpdateChannel = {
      poll: () => ({ pending_update: { constraint: 'updated' }, constraints_changed: true }),
    }

    const result = checkCallerUpdates(cs, channel, ctx)

    expect(result).toBe(RESTART_ITERATION)
  })
})

// ─── update_task_graph ────────────────────────────────────────────────────────

describe('update_task_graph', () => {
  it('circular depends_on raises GraphCycleError at update time', () => {
    const tg = new TaskGraph({ tasks: [
      makeTask({ id: 'a', depends_on: ['b'] }),
      makeTask({ id: 'b', depends_on: ['a'] }),
    ] })

    expect(() => updateTaskGraph('obj', new WorldModel(), new HypothesisSet(), tg))
      .toThrow(GraphCycleError)
  })

  it('conflict_probability_cache per write-domain pair estimated from task_graph structure', () => {
    const tg = new TaskGraph({ tasks: [
      makeTask({ id: 'a', parallel_write_domains: ['domain_x', 'domain_y'] }),
      makeTask({ id: 'b', parallel_write_domains: ['domain_x', 'domain_z'] }),
    ] })

    updateTaskGraph('obj', new WorldModel(), new HypothesisSet(), tg)

    expect(tg.getConflictProbability('domain_x', 'domain_y')).toBeGreaterThan(0)
    expect(tg.getConflictProbability('domain_x', 'domain_z')).toBeGreaterThan(0)
  })
})

// ─── select_task ─────────────────────────────────────────────────────────────

describe('select_task', () => {
  it('task with one incomplete depends_on is not eligible for selection', () => {
    const tg = new TaskGraph({ tasks: [
      makeTask({ id: 'dep', status: 'PENDING' }),
      makeTask({ id: 'target', depends_on: ['dep'] }),
    ] })
    const cs = new ControlState()

    const result = selectTask(tg, cs)

    // Only 'dep' is eligible (no unmet depends_on); 'target' is not
    expect(result.task?.id).toBe('dep')
    expect(result.task?.id).not.toBe('target')
  })

  it('escalation_reason=HUMAN_REQUIRED → escalate immediately without selecting any task', () => {
    const tg = new TaskGraph({ tasks: [makeTask({ id: 't1' })] })
    const cs = new ControlState({ escalation_reason: 'HUMAN_REQUIRED' })

    const result = selectTask(tg, cs)

    expect(result.escalate).toBe(true)
    expect(result.task).toBeNull()
  })

  it('conflict_prob > 0.5 → pessimistic path blocks overlapping parallel task', () => {
    const tg = new TaskGraph({ tasks: [
      makeTask({ id: 'a', risk_level: 'HIGH', parallel_write_domains: ['zone_a'] }),
      makeTask({ id: 'b', risk_level: 'MEDIUM', parallel_write_domains: ['zone_a'] }),
    ] })
    tg.setConflictProbability('zone_a', 'zone_a', 0.8)
    const cs = new ControlState()

    const result = selectTask(tg, cs)

    expect(result.task?.id).toBe('a')
    expect(result.concurrentTask).toBeNull()
  })

  it('conflict_prob ≤ 0.5 → optimistic path; both tasks proceed concurrently', () => {
    const tg = new TaskGraph({ tasks: [
      makeTask({ id: 'a', risk_level: 'HIGH', parallel_write_domains: ['zone_a'] }),
      makeTask({ id: 'b', risk_level: 'MEDIUM', parallel_write_domains: ['zone_a'] }),
    ] })
    tg.setConflictProbability('zone_a', 'zone_a', 0.3)
    const cs = new ControlState()

    const result = selectTask(tg, cs)

    expect(result.task?.id).toBe('a')
    expect(result.concurrentTask?.id).toBe('b')
  })

  it('parallel branch merge takes max(generation_id) across joining branches', () => {
    const branch1 = { worldModel: new WorldModel({ generation_id: 3 }), controlState: new ControlState() }
    const branch2 = { worldModel: new WorldModel({ generation_id: 5 }), controlState: new ControlState() }

    const result = reconcileParallelBranches(
      [branch1, branch2], new TaskGraph(),
      healthyDiagnostics(), new FailureDiagnostics(),
      new EvidenceStore({ tool_availability_manifest: {} }), new HypothesisSet(),
      (d, w, f) => resolveControlState(d, w, f),
    )

    expect(result.worldModel.generation_id).toBe(5)
  })

  it('parallel branch merge runs contradiction detection on merged world model', () => {
    const wm1 = new WorldModel({ generation_id: 2 })
    wm1.beliefs.push({ id: 'b1', statement: 'the deployment was a success', confidence: 1.0, derived_from: ['o1'], recorded_at: NOW })
    const wm2 = new WorldModel({ generation_id: 3 })
    wm2.beliefs.push({ id: 'b2', statement: 'the deployment was a failure', confidence: 1.0, derived_from: ['o2'], recorded_at: NOW })

    const result = reconcileParallelBranches(
      [
        { worldModel: wm1, controlState: new ControlState() },
        { worldModel: wm2, controlState: new ControlState() },
      ],
      new TaskGraph(),
      healthyDiagnostics(), new FailureDiagnostics(),
      new EvidenceStore({ tool_availability_manifest: {} }), new HypothesisSet(),
      (d, w, f) => resolveControlState(d, w, f),
    )

    expect(result.worldModel.contradictions.length).toBeGreaterThan(0)
  })

  it('cross-domain pairs recorded with conflict_observed=False at merge (refines cache estimates)', () => {
    const tg = new TaskGraph({ tasks: [
      makeTask({ id: 'a', parallel_write_domains: ['dom_x'] }),
      makeTask({ id: 'b', parallel_write_domains: ['dom_x'] }),
    ] })
    tg.setConflictProbability('dom_x', 'dom_x', 0.6)

    reconcileParallelBranches(
      [
        { worldModel: new WorldModel({ generation_id: 1 }), controlState: new ControlState() },
        { worldModel: new WorldModel({ generation_id: 2 }), controlState: new ControlState() },
      ],
      tg, healthyDiagnostics(), new FailureDiagnostics(),
      new EvidenceStore({ tool_availability_manifest: {} }), new HypothesisSet(),
      (d, w, f) => resolveControlState(d, w, f),
      [['dom_x', 'dom_x']],
    )

    expect(tg.getConflictProbability('dom_x', 'dom_x')).toBeLessThan(0.6)
  })
})

// ─── estimate_risk ────────────────────────────────────────────────────────────

describe('estimate_risk', () => {
  it('infrastructure module → HIGH risk; test file → LOW risk', () => {
    const tg = new TaskGraph()
    const wm = new WorldModel()

    const infra: RiskableAction = { module_type: 'infrastructure', metadata: {} }
    const test: RiskableAction = { module_type: 'test', metadata: {} }

    expect(estimateRisk(infra, tg, wm)).toBe('HIGH')
    expect(estimateRisk(test, tg, wm)).toBe('LOW')
  })

  it('HIGH risk action carries reduce_edit_size + increase_verification recommendations in metadata', () => {
    const tg = new TaskGraph()
    const wm = new WorldModel()
    const action: RiskableAction = { module_type: 'infrastructure', metadata: {} }

    estimateRisk(action, tg, wm)

    expect(action.metadata['reduce_edit_size']).toBe(true)
    expect(action.metadata['increase_verification']).toBe(true)
  })
})

// ─── estimate_voi ─────────────────────────────────────────────────────────────

describe('estimate_voi', () => {
  it('high VOI triggers gather_additional_evidence() before action selection', () => {
    const diag = new Diagnostics({
      belief_health: { freshness: 0.8, consistency: 0.8, support: 0.8 },
      coverage_health: { symptom_coverage: 0.7, explanation_coverage: 0.6 },
      verification_health: { strength: 0.1, feasibility: 0.8 }, // low strength → high decision_impact
      execution_health: { progress_rate: 0.8, failure_recurrence: 0.1, oscillation_score: 0.1 },
      dep_class_gap_annotation: '',
    })
    const wm = new WorldModel()
    const hs = new HypothesisSet({
      active: [
        { id: 'h1', explanation: 'cause A', confidence: 0.6, predicted_observations: [], discriminating_evidence: [], generation_sources: [], diversity_score: 0.5 },
        { id: 'h2', explanation: 'cause B', confidence: 0.4, predicted_observations: [], discriminating_evidence: [], generation_sources: [], diversity_score: 0.5 },
        { id: 'h3', explanation: 'cause C', confidence: 0.3, predicted_observations: [], discriminating_evidence: [], generation_sources: [], diversity_score: 0.5 },
      ],
    })
    const manifest = {
      tool_a: { available: true, fallback_tool: null },
      tool_b: { available: true, fallback_tool: null },
    }

    const result = estimateVOI(diag, wm, hs, manifest)

    expect(result.should_gather_evidence).toBe(true)
    expect(result.voi).toBeGreaterThan(0.5)
  })

  it('unresolvable adequacy shortfall updates verification_health.strength → TIER 2 picks it up next iteration', () => {
    const diag = healthyDiagnostics()
    const wm = new WorldModel()
    const hs = new HypothesisSet()
    // All tools unavailable with no fallbacks
    const manifest = {
      tool_a: { available: false, fallback_tool: null },
      tool_b: { available: false, fallback_tool: null },
      tool_c: { available: false, fallback_tool: null },
    }

    const result = estimateVOI(diag, wm, hs, manifest)

    expect(result.adequacy_unresolvable).toBe(true)
    expect(result.updated_verification_strength).not.toBeNull()
    // Strength updated to low value so TIER 2 < CRITICAL_THRESHOLD can fire next iteration
    expect(diag.verification_health.strength).toBe(result.updated_verification_strength)
    expect(diag.verification_health.strength!).toBeLessThan(0.3)
  })
})
