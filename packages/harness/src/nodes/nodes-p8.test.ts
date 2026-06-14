import { describe, it, expect } from 'vitest'
import { WorldModel, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js'
import { EvidenceStore } from '../state/evidence-store.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { Diagnostics } from '../state/diagnostics.js'
import { TaskGraph } from '../state/task-graph.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { MemoryState } from '../state/memory-state.js'
import { normalise, DimensionType } from '../normalise.js'
import { gatherEvidence } from './gather-evidence.js'
import { applyToolReliability } from './apply-tool-reliability.js'
import { updateWorldModel, propagateBeliefs } from './update-world-model.js'
import { detectContradictions } from './detect-contradictions.js'
import { generateUpdateHypotheses } from './generate-update-hypotheses.js'
import { updateDiagnostics } from './update-diagnostics.js'

// ─── gather_evidence ───────────────────────────────────────────────────────

describe('gather_evidence', () => {
  it('evidence_type=SYSTEM_ERROR carries reliability=HIGH automatically', () => {
    const store = new EvidenceStore({
      tool_availability_manifest: { tool_a: { available: true, fallback_tool: null } },
    })
    const result = gatherEvidence(
      { id: 'e1', obs: 'crash detected', source: 'tool_a', evidence_type: 'SYSTEM_ERROR', reliability: 'LOW' },
      store,
    )
    expect(result).not.toBeUndefined()
    expect(result!.reliability).toBe('HIGH')
  })

  it('OBSERVATION evidence stored in observations[], never auto-promoted to beliefs[]', () => {
    const store = new EvidenceStore({
      tool_availability_manifest: { tool_a: { available: true, fallback_tool: null } },
    })
    gatherEvidence(
      { id: 'e1', obs: 'value is 42', source: 'tool_a', evidence_type: 'OBSERVATION', reliability: 'MEDIUM' },
      store,
    )
    expect(store.observations).toHaveLength(1)
    expect(store.observations[0].evidence_type).toBe('OBSERVATION')
    // observations[] only — no beliefs array on EvidenceStore
  })

  it('unavailable tool → no Evidence object created; warning event emitted', () => {
    const store = new EvidenceStore({
      tool_availability_manifest: { tool_b: { available: false, fallback_tool: null } },
    })
    const warnings: string[] = []
    const result = gatherEvidence(
      { id: 'e1', obs: 'something', source: 'tool_b', evidence_type: 'OBSERVATION' },
      store,
      (msg) => warnings.push(msg),
    )
    expect(result).toBeUndefined()
    expect(store.observations).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('tool_b')
  })
})

// ─── apply_tool_reliability ────────────────────────────────────────────────

describe('apply_tool_reliability', () => {
  it('LOW envelope caps HIGH observation reliability to LOW conclusion reliability', () => {
    const store = new EvidenceStore({
      tool_reliability_envelopes: {
        tool_a: { tool: 'tool_a', max_observation_reliability: 'HIGH', max_conclusion_reliability: 'LOW' },
      },
      tool_availability_manifest: {},
    })
    const diagnostics = new Diagnostics()
    const original = { id: 'e1', obs: 'x', reliability: 'HIGH' as const, source: 'tool_a', evidence_type: 'OBSERVATION' as const, freshness: '' }
    const result = applyToolReliability(original, store, diagnostics)
    expect(result.reliability).toBe('LOW')
  })

  it('returns new Evidence object; original evidence object not mutated', () => {
    const store = new EvidenceStore({
      tool_reliability_envelopes: {
        tool_a: { tool: 'tool_a', max_observation_reliability: 'HIGH', max_conclusion_reliability: 'MEDIUM' },
      },
      tool_availability_manifest: {},
    })
    const diagnostics = new Diagnostics()
    const original = { id: 'e1', obs: 'x', reliability: 'HIGH' as const, source: 'tool_a', evidence_type: 'OBSERVATION' as const, freshness: '' }
    const result = applyToolReliability(original, store, diagnostics)
    expect(result).not.toBe(original)
    expect(original.reliability).toBe('HIGH')
    expect(result.reliability).toBe('MEDIUM')
  })

  it('updates verification_health.feasibility from tool_envelope_gap count', () => {
    const store = new EvidenceStore({
      tool_reliability_envelopes: {
        tool_a: { tool: 'tool_a', max_observation_reliability: 'HIGH', max_conclusion_reliability: 'LOW' },
        tool_b: { tool: 'tool_b', max_observation_reliability: 'HIGH', max_conclusion_reliability: 'HIGH' },
      },
      tool_availability_manifest: {},
    })
    const diagnostics = new Diagnostics({ verification_health: { strength: 1.0, feasibility: 1.0 } })
    const original = { id: 'e1', obs: 'x', reliability: 'HIGH' as const, source: 'tool_a', evidence_type: 'OBSERVATION' as const, freshness: '' }
    applyToolReliability(original, store, diagnostics)
    // 1 LOW out of 2 total → gapRatio=0.5 → feasibility = 1-0.5 = 0.5
    expect(diagnostics.verification_health.feasibility).toBeCloseTo(0.5)
  })
})

// ─── update_world_model ─────────────────────────────────────────────────────

describe('update_world_model', () => {
  it('observation added to observations[] only', () => {
    const wm = new WorldModel()
    const diagnostics = new Diagnostics()
    const evidence = { id: 'e1', obs: 'cache miss detected', reliability: 'MEDIUM' as const, source: 'monitor', evidence_type: 'OBSERVATION' as const, freshness: new Date().toISOString() }
    updateWorldModel(evidence, wm, diagnostics)
    expect(wm.observations).toHaveLength(1)
    expect(wm.beliefs).toHaveLength(0)
  })

  it('belief creation without derived_from[] throws (invariant enforced at write)', () => {
    const wm = new WorldModel()
    const diagnostics = new Diagnostics()
    const evidence = { id: 'e1', obs: 'inferred state', reliability: 'HIGH' as const, source: 'reasoner', evidence_type: 'INFERENCE' as const, freshness: new Date().toISOString() }
    // No beliefInput → derived_from defaults to [] → addBelief throws
    expect(() => updateWorldModel(evidence, wm, diagnostics)).toThrow()
  })

  it('belief_health.freshness = normalise(1 - stale_flag_ratio, ratio)', () => {
    const wm = new WorldModel({
      completeness_flags: { region_a: true, region_b: false, region_c: false },
    })
    const diagnostics = new Diagnostics()
    const evidence = { id: 'e1', obs: 'obs', reliability: 'LOW' as const, source: 'src', evidence_type: 'OBSERVATION' as const, freshness: new Date().toISOString() }
    updateWorldModel(evidence, wm, diagnostics)
    // After the update: region_a=true, region_b=false, region_c=false, src=true → 2/4 stale → stale_flag_ratio=0.5
    const expectedFreshness = normalise(1 - 0.5, DimensionType.ratio)
    expect(diagnostics.belief_health.freshness).toBeCloseTo(expectedFreshness)
  })

  it('belief_health.consistency = normalise(1 - contradiction_density, ratio)', () => {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'x', confidence: 1.0, derived_from: ['o1'], recorded_at: '' })
    wm.beliefs.push({ id: 'b2', statement: 'y', confidence: 0.5, derived_from: ['o2'], recorded_at: '' })
    wm.contradictions.push({ id: 'c1', type: 'pairwise', severity: 'HIGH', scope: 'local', description: '', involved_belief_ids: ['b1', 'b2'] })
    const diagnostics = new Diagnostics()
    const evidence = { id: 'e1', obs: 'obs', reliability: 'LOW' as const, source: 'src', evidence_type: 'OBSERVATION' as const, freshness: new Date().toISOString() }
    updateWorldModel(evidence, wm, diagnostics)
    // 1 contradiction / 2 beliefs = 0.5 density → consistency = normalise(0.5, ratio) = 0.5
    expect(diagnostics.belief_health.consistency).toBeCloseTo(0.5)
  })

  it('belief_health.support = normalise(mean_confidence, ratio)', () => {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'x', confidence: 1.0, derived_from: ['o1'], recorded_at: '' })
    wm.beliefs.push({ id: 'b2', statement: 'y', confidence: 0.0, derived_from: ['o2'], recorded_at: '' })
    const diagnostics = new Diagnostics()
    const evidence = { id: 'e1', obs: 'obs', reliability: 'LOW' as const, source: 'src', evidence_type: 'OBSERVATION' as const, freshness: new Date().toISOString() }
    updateWorldModel(evidence, wm, diagnostics)
    // mean = (1.0 + 0.0) / 2 = 0.5 → support = 0.5
    expect(diagnostics.belief_health.support).toBeCloseTo(0.5)
  })

  it('completeness_flags{} updated when belief regions confirmed or newly pruned', () => {
    const wm = new WorldModel()
    const diagnostics = new Diagnostics()
    const evidence = { id: 'e1', obs: 'obs', reliability: 'MEDIUM' as const, source: 'tool_x', evidence_type: 'OBSERVATION' as const, freshness: new Date().toISOString() }
    updateWorldModel(evidence, wm, diagnostics, undefined, 'region_x', false)
    expect(wm.completeness_flags['region_x']).toBe(true)

    // pruned region
    const evidence2 = { id: 'e2', obs: 'obs2', reliability: 'LOW' as const, source: 'tool_y', evidence_type: 'OBSERVATION' as const, freshness: new Date().toISOString() }
    updateWorldModel(evidence2, wm, diagnostics, undefined, 'region_y', true)
    expect(wm.completeness_flags['region_y']).toBe(false)
  })
})

// ─── propagate_beliefs ──────────────────────────────────────────────────────

describe('propagate_beliefs', () => {
  it('low-confidence edge reduces propagated weight proportionally to edge confidence', () => {
    const wm = new WorldModel()
    const depGraph = new BeliefDepGraph({
      belief_nodes: [
        { belief_id: 'b_source', confidence: 0.8 },
        { belief_id: 'b_target', confidence: 1.0 },
      ],
      derived_from_edges: [
        { from: 'b_source', to: 'b_target', confidence: 0.5, verified: false },
      ],
      invalidation_frontier: [],
      propagation_queue: [],
      unverified_edge_ratio: 0,
      confidence_decay_rate: 0.05,
    })
    const budget = new DepGraphBudget({ max_unverified_edge_ratio: 0.9 })
    propagateBeliefs(depGraph, budget, wm)
    const target = depGraph.belief_nodes.find(n => n.belief_id === 'b_target')!
    // target.confidence = min(1.0, 0.8 * 0.5) = 0.4
    expect(target.confidence).toBeCloseTo(0.4)
  })

  it('budget breach (unverified_edge_ratio > max) widens invalidation frontier to downstream nodes', () => {
    const wm = new WorldModel()
    const depGraph = new BeliefDepGraph({
      belief_nodes: [
        { belief_id: 'n_a', confidence: 0.7 },
        { belief_id: 'n_b', confidence: 0.7 },
        { belief_id: 'n_c', confidence: 0.7 },
      ],
      derived_from_edges: [
        { from: 'n_a', to: 'n_b', confidence: 0.5, verified: false },
        { from: 'n_b', to: 'n_c', confidence: 0.5, verified: false },
      ],
      invalidation_frontier: ['n_a'],
      propagation_queue: [],
      unverified_edge_ratio: 0,
      confidence_decay_rate: 0.05,
    })
    // Recompute ratio: 2 unverified / 2 total = 1.0
    depGraph.recomputeUnverifiedEdgeRatio()
    const budget = new DepGraphBudget({ max_unverified_edge_ratio: 0.3 })
    propagateBeliefs(depGraph, budget, wm)
    // n_a is frontier → n_b added as downstream
    expect(depGraph.invalidation_frontier).toContain('n_b')
  })
})

// ─── detect_contradictions ──────────────────────────────────────────────────

describe('detect_contradictions', () => {
  it('SYSTEM_BREAKING enters contradictions[] — does NOT throw, does NOT halt loop', () => {
    const wm = new WorldModel()
    // Both HIGH confidence → SYSTEM_BREAKING
    wm.beliefs.push({ id: 'b1', statement: 'system is stable', confidence: 1.0, derived_from: ['o1'], recorded_at: '' })
    wm.beliefs.push({ id: 'b2', statement: 'NOT: system is stable', confidence: 1.0, derived_from: ['o2'], recorded_at: '' })
    const store = new EvidenceStore()
    const hyps = new HypothesisSet()
    expect(() => detectContradictions(wm, store, hyps)).not.toThrow()
    expect(wm.contradictions).toHaveLength(1)
    expect(wm.contradictions[0].severity).toBe('SYSTEM_BREAKING')
  })

  it('pairwise type detected on two directly conflicting beliefs', () => {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'cache is valid', confidence: 0.0, derived_from: ['o1'], recorded_at: '' })
    wm.beliefs.push({ id: 'b2', statement: 'NOT: cache is valid', confidence: 0.0, derived_from: ['o2'], recorded_at: '' })
    detectContradictions(wm, new EvidenceStore(), new HypothesisSet())
    expect(wm.contradictions).toHaveLength(1)
    expect(wm.contradictions[0].type).toBe('pairwise')
  })

  it('temporal type detected on belief that conflicts with its prior-version entry', () => {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'state_v1', statement: 'state is A', confidence: 1.0, derived_from: ['o1'], recorded_at: '2024-01-01T00:00:00Z' })
    wm.beliefs.push({ id: 'state_v2', statement: 'state is B', confidence: 1.0, derived_from: ['o2'], recorded_at: '2024-01-02T00:00:00Z' })
    detectContradictions(wm, new EvidenceStore(), new HypothesisSet())
    expect(wm.contradictions).toHaveLength(1)
    expect(wm.contradictions[0].type).toBe('temporal')
    expect(wm.contradictions[0].involved_belief_ids).toContain('state_v1')
    expect(wm.contradictions[0].involved_belief_ids).toContain('state_v2')
  })

  it('scope=local for single-task contradiction; scope=global for objective-level', () => {
    // local scope: no global/objective keywords
    const wmLocal = new WorldModel()
    wmLocal.beliefs.push({ id: 'b1', statement: 'cache hit rate is high', confidence: 0.0, derived_from: ['o1'], recorded_at: '' })
    wmLocal.beliefs.push({ id: 'b2', statement: 'NOT: cache hit rate is high', confidence: 0.0, derived_from: ['o2'], recorded_at: '' })
    detectContradictions(wmLocal, new EvidenceStore(), new HypothesisSet())
    expect(wmLocal.contradictions[0].scope).toBe('local')

    // global scope: statement contains "objective"
    const wmGlobal = new WorldModel()
    wmGlobal.beliefs.push({ id: 'b3', statement: 'objective: system is healthy', confidence: 0.0, derived_from: ['o3'], recorded_at: '' })
    wmGlobal.beliefs.push({ id: 'b4', statement: 'NOT: objective: system is healthy', confidence: 0.0, derived_from: ['o4'], recorded_at: '' })
    detectContradictions(wmGlobal, new EvidenceStore(), new HypothesisSet())
    expect(wmGlobal.contradictions[0].scope).toBe('global')
  })
})

// ─── generate_update_hypotheses ─────────────────────────────────────────────

describe('generate_update_hypotheses', () => {
  function makeStore(): EvidenceStore {
    return new EvidenceStore({
      observations: [{ id: 'o1', obs: 'test failed', reliability: 'HIGH', source: 'runner', evidence_type: 'OBSERVATION', freshness: '' }],
      tool_reliability_envelopes: {},
      tool_availability_manifest: {},
    })
  }

  it('all 4 generation sources contribute at least one hypothesis', () => {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'prior belief', confidence: 0.5, derived_from: ['o1'], recorded_at: '' })
    const store = makeStore()
    const hyps = new HypothesisSet()
    const fd = new FailureDiagnostics()
    const mem = new MemoryState()
    generateUpdateHypotheses(wm, store, hyps, fd, mem)
    const sources = new Set(hyps.active.flatMap(h => h.generation_sources))
    expect(sources.has('symptom_inference')).toBe(true)
    expect(sources.has('counterfactual')).toBe(true)
    expect(sources.has('failure_mode_library')).toBe(true)
    expect(sources.has('analogy')).toBe(true)
  })

  it('diversity_score < 0.7 forces additional generation passes until threshold met', () => {
    // Pre-populate with only 1 source — diversity starts below 0.7
    const wm = new WorldModel()
    const store = makeStore()
    const hyps = new HypothesisSet({
      active: [
        { id: 'pre1', explanation: 'prior', confidence: 0.5, predicted_observations: [], discriminating_evidence: [], generation_sources: ['symptom_inference'], diversity_score: 0 },
        { id: 'pre2', explanation: 'prior2', confidence: 0.5, predicted_observations: [], discriminating_evidence: [], generation_sources: ['symptom_inference'], diversity_score: 0 },
        { id: 'pre3', explanation: 'prior3', confidence: 0.5, predicted_observations: [], discriminating_evidence: [], generation_sources: ['symptom_inference'], diversity_score: 0 },
      ],
    })
    const fd = new FailureDiagnostics()
    const mem = new MemoryState()
    generateUpdateHypotheses(wm, store, hyps, fd, mem)
    // After the call, all 4 sources should be represented → diversity ≥ 0.7
    const sources = new Set(hyps.active.flatMap(h => h.generation_sources))
    expect(sources.size).toBeGreaterThanOrEqual(3)
    const anyAboveThreshold = hyps.active.some(h => h.diversity_score >= 0.7)
    expect(anyAboveThreshold).toBe(true)
  })

  it('elimination_policy removes hypothesis when posterior falls below FLOOR', () => {
    const wm = new WorldModel()
    const store = new EvidenceStore({ tool_availability_manifest: {}, tool_reliability_envelopes: {}, observations: [] })
    const hyps = new HypothesisSet({
      active: [
        { id: 'h_low', explanation: 'low confidence', confidence: 0.01, predicted_observations: [], discriminating_evidence: [], generation_sources: ['analogy'], diversity_score: 0 },
      ],
      elimination_policy: { conditions: ['contradicting_evidence'], retention_k: 10, floor: 0.05 },
    })
    const fd = new FailureDiagnostics()
    const mem = new MemoryState()
    generateUpdateHypotheses(wm, store, hyps, fd, mem)
    // h_low had confidence 0.01 < floor 0.05 → eliminated
    const ids = hyps.active.map(h => h.id)
    expect(ids).not.toContain('h_low')
    expect(hyps.eliminated.some(h => h.id === 'h_low')).toBe(true)
  })

  it('eliminated set capped at K; oldest entry evicted when capacity exceeded', () => {
    const wm = new WorldModel()
    const store = new EvidenceStore({ tool_availability_manifest: {}, tool_reliability_envelopes: {}, observations: [] })
    // Pre-fill eliminated to capacity (k=3) and add one more low-confidence active hypothesis
    const hyps = new HypothesisSet({
      active: [
        { id: 'h_new_low', explanation: 'will be eliminated', confidence: 0.01, predicted_observations: [], discriminating_evidence: [], generation_sources: ['analogy'], diversity_score: 0 },
      ],
      eliminated: [
        { id: 'old_1', explanation: 'e1', confidence: 0.01, predicted_observations: [], discriminating_evidence: [], generation_sources: [], diversity_score: 0 },
        { id: 'old_2', explanation: 'e2', confidence: 0.01, predicted_observations: [], discriminating_evidence: [], generation_sources: [], diversity_score: 0 },
        { id: 'old_3', explanation: 'e3', confidence: 0.01, predicted_observations: [], discriminating_evidence: [], generation_sources: [], diversity_score: 0 },
      ],
      elimination_policy: { conditions: ['contradicting_evidence'], retention_k: 3, floor: 0.05 },
    })
    const fd = new FailureDiagnostics()
    const mem = new MemoryState()
    generateUpdateHypotheses(wm, store, hyps, fd, mem)
    // h_new_low eliminated → eliminated has 4 entries, cap=3 → old_1 evicted
    expect(hyps.eliminated.length).toBeLessThanOrEqual(3)
    expect(hyps.eliminated.some(h => h.id === 'old_1')).toBe(false)
  })

  it('MAX_BELIEFS=10 / KEEP_BELIEFS=5 pruning recorded in pruned_regions[]', () => {
    const wm = new WorldModel()
    const store = new EvidenceStore({ tool_availability_manifest: {}, tool_reliability_envelopes: {}, observations: [] })
    // Pre-load 11 active hypotheses so MAX_BELIEFS=10 is exceeded
    const hyps = new HypothesisSet({
      active: Array.from({ length: 11 }, (_, i) => ({
        id: `h${i}`,
        explanation: `hypothesis ${i}`,
        confidence: (11 - i) / 11,  // descending confidence
        predicted_observations: [],
        discriminating_evidence: [],
        generation_sources: ['symptom_inference'],
        diversity_score: 0,
      })),
    })
    const fd = new FailureDiagnostics()
    const mem = new MemoryState()
    generateUpdateHypotheses(wm, store, hyps, fd, mem)
    // After pruning: active ≤ KEEP_BELIEFS=5; pruned_regions should be non-empty
    expect(hyps.active.length).toBeLessThanOrEqual(5)
    expect(mem.compression_risk.pruned_regions.length).toBeGreaterThan(0)
  })
})

// ─── update_diagnostics ──────────────────────────────────────────────────────

describe('update_diagnostics', () => {
  function makeAll() {
    const wm = new WorldModel()
    wm.beliefs.push({ id: 'b1', statement: 'x', confidence: 1.0, derived_from: ['o1'], recorded_at: '' })
    wm.observations.push({ id: 'o1', content: 'obs', source: 'tool', recorded_at: '' })
    const hyps = new HypothesisSet({
      active: [{ id: 'h1', explanation: 'e', confidence: 0.5, predicted_observations: [], discriminating_evidence: [], generation_sources: ['symptom_inference'], diversity_score: 0.5 }],
    })
    const tg = new TaskGraph({ tasks: [{ id: 't1', description: 'd', status: 'COMPLETE', risk_level: 'LOW', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null }], changed: false })
    const fd = new FailureDiagnostics()
    const dg = new BeliefDepGraph()
    const diagnostics = new Diagnostics()
    return { wm, hyps, tg, fd, dg, diagnostics }
  }

  it('all health vector sub-dims pass assertNormalised() (no out-of-range values emitted)', () => {
    const { wm, hyps, tg, fd, dg, diagnostics } = makeAll()
    expect(() => updateDiagnostics(wm, hyps, tg, fd, dg, diagnostics)).not.toThrow()
    // All values must be in [0,1]
    const vals = [
      diagnostics.belief_health.freshness,
      diagnostics.belief_health.consistency,
      diagnostics.belief_health.support,
      diagnostics.coverage_health.symptom_coverage,
      diagnostics.coverage_health.explanation_coverage,
      diagnostics.verification_health.strength,
      diagnostics.verification_health.feasibility,
      diagnostics.execution_health.progress_rate,
      diagnostics.execution_health.failure_recurrence,
      diagnostics.execution_health.oscillation_score,
    ]
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('dep_class_gap_annotation is string attached to advisory field — not passed to any tier as a number', () => {
    const { wm, hyps, tg, fd, dg, diagnostics } = makeAll()
    updateDiagnostics(wm, hyps, tg, fd, dg, diagnostics)
    expect(typeof diagnostics.dep_class_gap_annotation).toBe('string')
    // Typing guarantees it is never a number — verify the runtime type
    expect(typeof (diagnostics as unknown as Record<string, unknown>)['dep_class_gap_annotation']).not.toBe('number')
  })

  it('abstraction_fit recalculated only when task_graph.changed flag is set', () => {
    const { wm, hyps, fd, dg, diagnostics } = makeAll()
    // Task graph with changed=false — feasibility should remain at its previous value
    const tgUnchanged = new TaskGraph({
      tasks: [{ id: 't1', description: 'd', status: 'PENDING', risk_level: 'HIGH', depends_on: [], parallel_write_domains: [], abstraction_level: 2, assigned_strategy: null }],
      changed: false,
    })
    const prevFeasibility = 0.99
    diagnostics.verification_health = { strength: 1.0, feasibility: prevFeasibility }
    updateDiagnostics(wm, hyps, tgUnchanged, fd, dg, diagnostics)
    // When !changed, abstraction_fit uses diagnostics.verification_health.feasibility as-is
    // The feasibility is recomputed using prevFeasibility as the abstraction_fit component
    // It should change from prevFeasibility only due to the composite (not abstraction recalc)
    const feasibilityAfterUnchanged = diagnostics.verification_health.feasibility

    // Now with changed=true — abstraction_fit recomputed from tasks (level=2 out of max 2)
    const tgChanged = new TaskGraph({
      tasks: [{ id: 't1', description: 'd', status: 'PENDING', risk_level: 'HIGH', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null }],
      changed: true,
    })
    diagnostics.verification_health = { strength: 1.0, feasibility: prevFeasibility }
    updateDiagnostics(wm, hyps, tgChanged, fd, dg, diagnostics)
    const feasibilityAfterChanged = diagnostics.verification_health.feasibility

    // The feasibility values should differ because abstraction_fit is recomputed on changed=true
    // abstraction_level=0 → fit=1.0 (concrete), abstraction_level=2 → fit=0.0 (abstract)
    // With changed=false we used prevFeasibility=0.99 as abstraction_fit → higher feasibility
    // With changed=true we used checkAbstractionAlignment() → different value
    expect(feasibilityAfterChanged).not.toBeCloseTo(feasibilityAfterUnchanged, 3)
  })
})
