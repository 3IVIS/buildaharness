import { describe, it, expect } from 'vitest'
import {
  WorldModel, type Belief, type Contradiction,
  BeliefDepGraph,
} from './world-model.js'
import { CallerState } from './caller-state.js'
import { ControlState } from './control-state.js'
import { TaskGraph, makeConflictKey } from './task-graph.js'
import { EvidenceStore } from './evidence-store.js'
import { MemoryState } from './memory-state.js'
import { StrategyState, DEFAULT_STRATEGY_ORDER } from './strategy-state.js'
import { HypothesisSet } from './hypothesis-set.js'
import { FailureModeLibrary } from './failure-diagnostics.js'

describe('WorldModel', () => {
  it('full toJSON/fromJSON round-trip preserves all fields including contradictions and completeness_flags', () => {
    const wm = new WorldModel()
    const contradiction: Contradiction = {
      id: 'c1', type: 'pairwise', severity: 'HIGH', scope: 'task',
      description: 'test', involved_belief_ids: ['b1', 'b2'],
    }
    wm.contradictions.push(contradiction)
    wm.completeness_flags['region_a'] = false
    wm.completeness_flags['region_b'] = true
    const json = wm.toJSON()
    const restored = WorldModel.fromJSON(json)
    expect(restored.contradictions).toHaveLength(1)
    expect(restored.contradictions[0].severity).toBe('HIGH')
    expect(restored.completeness_flags['region_a']).toBe(false)
    expect(restored.completeness_flags['region_b']).toBe(true)
  })

  it('generation_id increments monotonically with each significant update call', () => {
    const wm = new WorldModel()
    expect(wm.generation_id).toBe(0)
    wm.incrementGenerationId()
    expect(wm.generation_id).toBe(1)
    wm.incrementGenerationId()
    expect(wm.generation_id).toBe(2)
  })

  it('addBelief() throws if derived_from[] is empty', () => {
    const wm = new WorldModel()
    const belief: Belief = {
      id: 'b1', statement: 'test', confidence: 1.0,
      derived_from: [], recorded_at: new Date().toISOString(),
    }
    expect(() => wm.addBelief(belief)).toThrow()
  })

  it('completeness_flags{} records which regions were pruned during compression', () => {
    const wm = new WorldModel()
    wm.completeness_flags['beliefs.api_calls'] = false
    const json = wm.toJSON()
    expect(json.completeness_flags['beliefs.api_calls']).toBe(false)
    const restored = WorldModel.fromJSON(json)
    expect(restored.completeness_flags['beliefs.api_calls']).toBe(false)
  })
})

describe('CallerState', () => {
  it('constraints_changed flag set on any constraint mutation and cleared after propagation', () => {
    const cs = new CallerState()
    expect(cs.constraints_changed).toBe(false)
    cs.updateConstraints({ max_tokens: 4000 })
    expect(cs.constraints_changed).toBe(true)
    cs.resetConstraintsChanged()
    expect(cs.constraints_changed).toBe(false)
  })
})

describe('ControlState', () => {
  it('notes[] holds dep_class_gap_annotation as a string; no numeric field exposed', () => {
    const cs = new ControlState()
    cs.notes.push('gap: MEDIUM gap between abstraction level 2 and level 0')
    expect(typeof cs.notes[0]).toBe('string')
    // ControlState has no numeric field named dep_class_gap_annotation
    expect('dep_class_gap_annotation' in cs).toBe(false)
  })

  it('generation_id starts at 0 and matches worldModel.generation_id after stamping', () => {
    const cs = new ControlState()
    expect(cs.generation_id).toBe(0)
    cs.stampGenerationId(7)
    expect(cs.generation_id).toBe(7)
  })
})

describe('TaskGraph', () => {
  it('COMPLETE status is terminal — any further status transition raises an error', () => {
    const tg = new TaskGraph({
      tasks: [{
        id: 't1', description: 'task', status: 'COMPLETE',
        risk_level: 'LOW', depends_on: [], parallel_write_domains: [],
        abstraction_level: 0, assigned_strategy: null,
      }],
    })
    expect(() => tg.setStatus('t1', 'RUNNING')).toThrow()
  })

  it('FAILED set only by execution layer — planning logic cannot set it directly', () => {
    const tg = new TaskGraph({
      tasks: [{
        id: 't1', description: 'task', status: 'RUNNING',
        risk_level: 'LOW', depends_on: [], parallel_write_domains: [],
        abstraction_level: 0, assigned_strategy: null,
      }],
    })
    expect(() => tg.setStatus('t1', 'FAILED')).toThrow()
    // Should succeed with flag
    expect(() => tg.setStatus('t1', 'FAILED', { fromExecutionLayer: true })).not.toThrow()
  })

  it('selectUnblockedLeaf returns HIGH risk tasks before MEDIUM before LOW (stable sort)', () => {
    const tg = new TaskGraph({
      tasks: [
        { id: 'low1', description: 'low1', status: 'PENDING', risk_level: 'LOW', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null },
        { id: 'high1', description: 'high1', status: 'PENDING', risk_level: 'HIGH', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null },
        { id: 'med1', description: 'med1', status: 'PENDING', risk_level: 'MEDIUM', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null },
        { id: 'high2', description: 'high2', status: 'PENDING', risk_level: 'HIGH', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null },
      ],
    })
    const first = tg.selectUnblockedLeaf()
    expect(first?.risk_level).toBe('HIGH')
    expect(first?.id).toBe('high1')  // stable sort: first HIGH in insertion order
  })

  it('conflict_probability_cache key for (da, db) equals key for (db, da)', () => {
    expect(makeConflictKey('domain_a', 'domain_b')).toBe(makeConflictKey('domain_b', 'domain_a'))
    expect(makeConflictKey('x', 'y')).toBe('x::y')
    expect(makeConflictKey('y', 'x')).toBe('x::y')
  })
})

describe('EvidenceStore', () => {
  it('tool_availability_manifest populated and keyed by tool name string', () => {
    const es = new EvidenceStore({
      tool_availability_manifest: {
        'bash': { available: true, fallback_tool: null },
        'search': { available: false, fallback_tool: 'grep' },
      },
    })
    expect(es.tool_availability_manifest['bash']).toBeDefined()
    expect(es.tool_availability_manifest['bash'].available).toBe(true)
    expect(es.tool_availability_manifest['search'].fallback_tool).toBe('grep')
    expect(Object.keys(es.tool_availability_manifest)).toEqual(['bash', 'search'])
  })
})

describe('MemoryState', () => {
  it('action_dep_overlap() checks intersection against both compressed_structures[] and pruned_regions[]', () => {
    const ms = new MemoryState({
      compression_risk: {
        compressed_structures: [{ id: 'struct_a', description: '', token_count: 100 }],
        pruned_regions: [{ id: 'region_b', description: '', token_count: 50, pruned_at: '' }],
        dependent_tasks: [],
      },
    })
    // Overlaps with compressed_structures
    expect(ms.action_dep_overlap(['struct_a'])).toBe(true)
    // Overlaps with pruned_regions
    expect(ms.action_dep_overlap(['region_b'])).toBe(true)
    // No overlap
    expect(ms.action_dep_overlap(['other'])).toBe(false)
    // Checks both lists
    expect(ms.action_dep_overlap(['struct_a', 'region_b'])).toBe(true)
  })

  it('"structure present" does not mean "structure complete" — pruned regions tracked separately', () => {
    const ms = new MemoryState({
      compression_risk: {
        compressed_structures: [{ id: 'auth_module', description: 'compressed', token_count: 200 }],
        pruned_regions: [{ id: 'auth_module', description: 'pruned parts', token_count: 80, pruned_at: '2024-01-01' }],
        dependent_tasks: [],
      },
    })
    // Both lists can contain the same id — structure is present but not complete
    expect(ms.compression_risk.compressed_structures.find(s => s.id === 'auth_module')).toBeDefined()
    expect(ms.compression_risk.pruned_regions.find(r => r.id === 'auth_module')).toBeDefined()
    // action_dep_overlap detects overlap in either list
    expect(ms.action_dep_overlap(['auth_module'])).toBe(true)
  })
})

describe('StrategyState', () => {
  it('prior_strategy_weights is flat (uniform) when no experience store provided', () => {
    const ss = new StrategyState()
    const weights = Object.values(ss.prior_strategy_weights)
    expect(weights.length).toBeGreaterThan(0)
    const first = weights[0]
    weights.forEach(w => expect(w).toBeCloseTo(first))
  })

  it('recovery_strategy_order defaults to DIRECT_EDIT → TRACE_EXEC → BROADER_SEARCH → REIMPLEMENT → MINIMAL_FIX → ESCALATE', () => {
    const ss = new StrategyState()
    expect(ss.recovery_strategy_order).toEqual(DEFAULT_STRATEGY_ORDER)
  })
})

describe('EliminationPolicy — HypothesisSet', () => {
  it('last K eliminated retained; oldest entry evicted when K exceeded', () => {
    const hs = new HypothesisSet({
      active: [],
      eliminated: [],
      elimination_policy: { conditions: [], retention_k: 3, floor: 0.05 },
    })

    const makeH = (id: string) => ({
      id, explanation: '', confidence: 0.1,
      predicted_observations: [], discriminating_evidence: [],
      generation_sources: [], diversity_score: 0.5,
    })

    // Add 4 hypotheses (K=3, so oldest should be evicted)
    hs.active.push(makeH('h1'), makeH('h2'), makeH('h3'), makeH('h4'))
    hs.eliminate(makeH('h1'))
    hs.eliminate(makeH('h2'))
    hs.eliminate(makeH('h3'))
    expect(hs.eliminated).toHaveLength(3)
    expect(hs.eliminated.map(h => h.id)).toEqual(['h1', 'h2', 'h3'])

    hs.eliminate(makeH('h4'))
    // K=3, so h1 evicted, kept h2, h3, h4
    expect(hs.eliminated).toHaveLength(3)
    expect(hs.eliminated.map(h => h.id)).toEqual(['h2', 'h3', 'h4'])
  })
})

describe('FailureModeLibrary', () => {
  it('getEntries returns the curated entries passed to the constructor', () => {
    const entries = [
      { id: 'fm1', failure_class: 'timeout', symptoms: ['request timed out'], pattern_description: 'x' },
    ]
    const library = new FailureModeLibrary(entries)
    expect(library.getEntries()).toEqual(entries)
  })

  it('getEntries returns an empty array for a library with no curated entries', () => {
    const library = new FailureModeLibrary()
    expect(library.getEntries()).toEqual([])
  })

  it('match() uses substring containment, not exact equality — a paraphrase sharing no contiguous phrase with the curated symptom still finds nothing (the gap semanticFailureMatcher is layered on top to close)', () => {
    const library = new FailureModeLibrary([
      { id: 'fm1', failure_class: 'timeout', symptoms: ['request timed out'], pattern_description: 'x' },
    ])
    expect(library.match(['the request took too long and timed out eventually'])).toBeNull()
    expect(library.match(['request timed out'])).not.toBeNull()
  })

  it('match() finds a curated short phrase inside a longer free-text observation (e.g. a raw error message), case-insensitively', () => {
    const library = new FailureModeLibrary([
      { id: 'e1', failure_class: 'TIMEOUT', symptoms: ['request timed out'], pattern_description: 'x' },
    ])
    const result = library.match(['Tool execution failed: Error: request timed out after 30000ms'])
    expect(result).not.toBeNull()
    expect(result?.failure_class).toBe('TIMEOUT')
  })

  it('match() returns null when the observation shares no curated phrase with any entry', () => {
    const library = new FailureModeLibrary([
      { id: 'e1', failure_class: 'TIMEOUT', symptoms: ['request timed out'], pattern_description: 'x' },
    ])
    expect(library.match(['Tool execution failed: Error: permission denied writing to /etc/hosts'])).toBeNull()
  })
})
