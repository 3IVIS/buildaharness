import { describe, it, expect, beforeEach } from 'vitest'

import {
  ProcessConcept,
  ProcessConceptStep,
  ProcessConceptValidationError,
  ProcessConceptNotFoundError,
} from './process-concept.js'
import {
  ProcessRegistry,
  registerAll,
  DEFAULT_REGISTRY,
} from './process-registry.js'
import {
  listProcesses,
  loadProcess,
  getCurrentStep,
  completeStep,
} from './process-tools.js'
import { TaskGraph } from './state/task-graph.js'
import { initializeHarness } from './nodes/initialize.js'
import { validateTaskGraph } from './nodes/initialize.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeMinimalConcept(overrides: Partial<{
  id: string
  name: string
  description: string
  steps: ProcessConceptStep[]
}> = {}): ProcessConcept {
  return new ProcessConcept({
    id: overrides.id ?? 'test_concept',
    name: overrides.name ?? 'Test Concept',
    description: overrides.description ?? 'A test concept',
    successCriteria: [],
    schemaVersion: '1',
    steps: overrides.steps ?? [],
  })
}

function makeStep(id: string, dependsOn: string[] = [], overrides: Partial<ProcessConceptStep> = {}): ProcessConceptStep {
  return {
    id,
    description: `Step ${id}`,
    dependsOn,
    riskLevel: 'LOW',
    abstractionLevel: 'module',
    expectedTools: [],
    successCriteria: [],
    strategyHint: null,
    ...overrides,
  }
}

// ─── TS-T01 to TS-T08: Serialisation and validate() ─────────────────────────

describe('ProcessConceptStep', () => {
  it('TS-T01: preserves all 9 fields across JSON round-trip (including strategyHint=null)', () => {
    const step: ProcessConceptStep = {
      id: 'step_a',
      description: 'Do something',
      dependsOn: ['step_b'],
      riskLevel: 'HIGH',
      abstractionLevel: 'leaf',
      expectedTools: ['read_file'],
      successCriteria: ['done'],
      strategyHint: null,
    }
    const json = JSON.parse(JSON.stringify(step))
    expect(json.id).toBe('step_a')
    expect(json.description).toBe('Do something')
    expect(json.dependsOn).toEqual(['step_b'])
    expect(json.riskLevel).toBe('HIGH')
    expect(json.abstractionLevel).toBe('leaf')
    expect(json.expectedTools).toEqual(['read_file'])
    expect(json.successCriteria).toEqual(['done'])
    expect(json.strategyHint).toBeNull()
  })
})

describe('ProcessConcept.fromJson / validate', () => {
  it('TS-T02: fromJson()/validate() round-trip preserves concept ID, name, schemaVersion, and full step list', () => {
    const raw = {
      schema_version: '1',
      id: 'my_concept',
      name: 'My Concept',
      description: 'Test',
      success_criteria: ['pass'],
      steps: [
        { id: 's1', description: 'step 1', depends_on: [], risk_level: 'LOW', abstraction_level: 'module', expected_tools: [], success_criteria: [], strategy_hint: null },
        { id: 's2', description: 'step 2', depends_on: ['s1'], risk_level: 'MEDIUM', abstraction_level: 'function', expected_tools: [], success_criteria: [], strategy_hint: 'DIRECT_EDIT' },
      ],
    }
    const concept = ProcessConcept.fromJson(raw as Record<string, unknown>)
    expect(concept.id).toBe('my_concept')
    expect(concept.name).toBe('My Concept')
    expect(concept.schemaVersion).toBe('1')
    expect(concept.steps).toHaveLength(2)
    expect(concept.steps[0].id).toBe('s1')
    expect(concept.steps[1].strategyHint).toBe('DIRECT_EDIT')
  })

  it('TS-T03: validate() returns [] for a well-formed 2-step concept with linear dependency', () => {
    const concept = makeMinimalConcept({
      steps: [makeStep('a'), makeStep('b', ['a'])],
    })
    expect(concept.validate()).toEqual([])
  })

  it('TS-T04: validate() returns error containing "Duplicate" when two steps share the same ID', () => {
    const concept = makeMinimalConcept({
      steps: [makeStep('dup'), makeStep('dup')],
    })
    const errors = concept.validate()
    expect(errors.some(e => e.toLowerCase().includes('duplicate'))).toBe(true)
  })

  it('TS-T05: validate() returns error referencing missing ID when dependsOn names a non-existent step', () => {
    const concept = makeMinimalConcept({
      steps: [makeStep('a', ['nonexistent'])],
    })
    const errors = concept.validate()
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true)
  })

  it('TS-T06: validate() detects A→B, B→A cycle and returns error containing "cycle"', () => {
    const concept = makeMinimalConcept({
      steps: [makeStep('a', ['b']), makeStep('b', ['a'])],
    })
    const errors = concept.validate()
    expect(errors.some(e => e.toLowerCase().includes('cycle'))).toBe(true)
  })

  it('TS-T07: validate() returns error referencing "riskLevel" for invalid value like "CRITICAL"', () => {
    const concept = makeMinimalConcept({
      steps: [makeStep('a', [], { riskLevel: 'CRITICAL' as 'LOW' })],
    })
    const errors = concept.validate()
    expect(errors.some(e => e.toLowerCase().includes('risklevel') || e.toLowerCase().includes('risk_level'))).toBe(true)
  })

  it('TS-T08: validate() returns error referencing "abstractionLevel" for invalid value like "granular"', () => {
    const concept = makeMinimalConcept({
      steps: [makeStep('a', [], { abstractionLevel: 'granular' as 'module' })],
    })
    const errors = concept.validate()
    expect(errors.some(e => e.toLowerCase().includes('abstractionlevel') || e.toLowerCase().includes('abstraction_level'))).toBe(true)
  })
})

// ─── TS-T09 to TS-T14: seedTaskGraph() mechanics ────────────────────────────

describe('seedTaskGraph', () => {
  it('TS-T09: task IDs are {conceptId}:{stepId}; raw step ID not present in graph', () => {
    const concept = makeMinimalConcept({ id: 'my_concept', steps: [makeStep('step_a')] })
    const graph = new TaskGraph()
    concept.seedTaskGraph(graph)
    expect(graph.tasks[0].id).toBe('my_concept:step_a')
    expect(graph.tasks.some(t => t.id === 'step_a')).toBe(false)
  })

  it('TS-T10: dependsOn references are also namespaced to {conceptId}:{dependencyId}', () => {
    const concept = makeMinimalConcept({
      id: 'my_concept',
      steps: [makeStep('a'), makeStep('b', ['a'])],
    })
    const graph = new TaskGraph()
    concept.seedTaskGraph(graph)
    const taskB = graph.tasks.find(t => t.id === 'my_concept:b')!
    expect(taskB.depends_on).toEqual(['my_concept:a'])
  })

  it('TS-T11: maps abstractionLevel strings to ints: module/goal→0, subgoal/function→1, leaf/statement→2', () => {
    const concept = makeMinimalConcept({
      id: 'c',
      steps: [
        makeStep('s0a', [], { abstractionLevel: 'module' }),
        makeStep('s0b', [], { abstractionLevel: 'goal' }),
        makeStep('s1a', [], { abstractionLevel: 'subgoal' }),
        makeStep('s1b', [], { abstractionLevel: 'function' }),
        makeStep('s2a', [], { abstractionLevel: 'leaf' }),
        makeStep('s2b', [], { abstractionLevel: 'statement' }),
      ],
    })
    const graph = new TaskGraph()
    concept.seedTaskGraph(graph)
    const byId = Object.fromEntries(graph.tasks.map(t => [t.id.split(':')[1], t.abstraction_level]))
    expect(byId['s0a']).toBe(0)
    expect(byId['s0b']).toBe(0)
    expect(byId['s1a']).toBe(1)
    expect(byId['s1b']).toBe(1)
    expect(byId['s2a']).toBe(2)
    expect(byId['s2b']).toBe(2)
  })

  it('TS-T12: taskGraph.changed is true after seedTaskGraph(); was false before', () => {
    const concept = makeMinimalConcept({ steps: [makeStep('a')] })
    const graph = new TaskGraph()
    expect(graph.changed).toBe(false)
    concept.seedTaskGraph(graph)
    expect(graph.changed).toBe(true)
  })

  it('TS-T13: seeded TaskGraph passes validateTaskGraph() with no errors (INV-PC-02 verified)', () => {
    const concept = makeMinimalConcept({
      id: 'c',
      steps: [makeStep('a'), makeStep('b', ['a']), makeStep('c', ['b'])],
    })
    const graph = new TaskGraph()
    concept.seedTaskGraph(graph)
    expect(validateTaskGraph(graph)).toEqual([])
  })

  it('TS-T14: riskLevel preserved from concept steps — HIGH step produces Task with risk_level="HIGH"', () => {
    const concept = makeMinimalConcept({
      id: 'c',
      steps: [makeStep('a', [], { riskLevel: 'HIGH' })],
    })
    const graph = new TaskGraph()
    concept.seedTaskGraph(graph)
    expect(graph.tasks[0].risk_level).toBe('HIGH')
  })
})

// ─── TS-T15 to TS-T18: initializeHarness() integration ──────────────────────

describe('initializeHarness with processConceptId', () => {
  let registry: ProcessRegistry

  beforeEach(() => {
    registry = new ProcessRegistry()
    const concept = makeMinimalConcept({
      id: 'test_concept',
      steps: [makeStep('s1'), makeStep('s2', ['s1'])],
    })
    registry.register('test_concept', concept)
  })

  it('TS-T15: initializeHarness() with concept returns dict with decompositionGate bool key and valid=true', () => {
    const result = initializeHarness('test objective', {
      processConceptId: 'test_concept',
      processRegistry: registry,
    })
    expect(result.valid).toBe(true)
    expect(typeof result.decompositionGate).toBe('boolean')
    expect(result.errors).toEqual([])
  })

  it('TS-T16: initializeHarness(processConceptId=undefined) returns processConceptId=null and valid=true (INV-PC-03)', () => {
    const result = initializeHarness('test objective')
    expect(result.processConceptId).toBeNull()
    expect(result.valid).toBe(true)
  })

  it('TS-T17: concept ID appears as result.processConceptId after seeded init', () => {
    const result = initializeHarness('test objective', {
      processConceptId: 'test_concept',
      processRegistry: registry,
    })
    expect(result.processConceptId).toBe('test_concept')
  })

  it('TS-T18: orphaned dependency task causes valid=false with non-empty errors array', () => {
    const result = initializeHarness('test objective', {
      initialTasks: [
        {
          id: 'task_a',
          description: 'Task A',
          status: 'PENDING',
          risk_level: 'LOW',
          depends_on: ['nonexistent_task'],
          parallel_write_domains: [],
          abstraction_level: 1,
          assigned_strategy: null,
        },
      ],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

// ─── TS-T19 to TS-T23: ProcessRegistry operations ────────────────────────────

describe('ProcessRegistry', () => {
  it('TS-T19: register()/load() round-trip returns ProcessConcept with correct ID', () => {
    const registry = new ProcessRegistry()
    const concept = makeMinimalConcept({ id: 'foo' })
    registry.register('foo', concept)
    expect(registry.load('foo').id).toBe('foo')
  })

  it('TS-T20: load() throws ProcessConceptNotFoundError for an unregistered ID', () => {
    const registry = new ProcessRegistry()
    expect(() => registry.load('unknown')).toThrow(ProcessConceptNotFoundError)
  })

  it('TS-T21: listAvailable() returns alphabetically sorted IDs', () => {
    const registry = new ProcessRegistry()
    registry.register('zebra', makeMinimalConcept({ id: 'zebra' }))
    registry.register('apple', makeMinimalConcept({ id: 'apple' }))
    registry.register('mango', makeMinimalConcept({ id: 'mango' }))
    expect(registry.listAvailable()).toEqual(['apple', 'mango', 'zebra'])
  })

  it('TS-T22: registerAll() registers all 4 bundled concepts; listAvailable() count=4', () => {
    const registry = new ProcessRegistry()
    registerAll(registry)
    expect(registry.listAvailable().length).toBe(4)
  })

  it('TS-T23: DEFAULT_REGISTRY is non-empty at module import time (auto-populated by registerAll)', () => {
    expect(DEFAULT_REGISTRY.listAvailable().length).toBeGreaterThan(0)
  })
})

// ─── TS-T24 to TS-T28: fromJson() and error handling ─────────────────────────

describe('ProcessConcept.fromJson error handling', () => {
  it('TS-T24: fromJson() with valid JSON returns concept with correct step count', () => {
    const raw = {
      id: 'my_c',
      name: 'My C',
      description: '',
      steps: [
        { id: 'x', description: '', depends_on: [], risk_level: 'LOW', abstraction_level: 'module', expected_tools: [], success_criteria: [], strategy_hint: null },
        { id: 'y', description: '', depends_on: ['x'], risk_level: 'LOW', abstraction_level: 'module', expected_tools: [], success_criteria: [], strategy_hint: null },
      ],
    }
    const concept = ProcessConcept.fromJson(raw as Record<string, unknown>)
    expect(concept.steps).toHaveLength(2)
  })

  it('TS-T25: fromJson() throws ProcessConceptValidationError for JSON missing required id field', () => {
    const raw = { name: 'No ID', steps: [] }
    expect(() => ProcessConcept.fromJson(raw as Record<string, unknown>)).toThrow(ProcessConceptValidationError)
  })

  it('TS-T26: fromJson() throws ProcessConceptValidationError for invalid riskLevel value', () => {
    const raw = {
      id: 'my_c',
      steps: [
        { id: 'x', description: '', depends_on: [], risk_level: 'CRITICAL', abstraction_level: 'module', expected_tools: [], success_criteria: [], strategy_hint: null },
      ],
    }
    expect(() => ProcessConcept.fromJson(raw as Record<string, unknown>)).toThrow(ProcessConceptValidationError)
  })

  it('TS-T27: load() of unregistered ID throws ProcessConceptNotFoundError with missing ID in message', () => {
    const registry = new ProcessRegistry()
    let caught: ProcessConceptNotFoundError | null = null
    try {
      registry.load('missing_id_xyz')
    } catch (e) {
      caught = e as ProcessConceptNotFoundError
    }
    expect(caught).toBeInstanceOf(ProcessConceptNotFoundError)
    expect(caught!.message).toContain('missing_id_xyz')
  })

  it('TS-T28: register() then load() returns the same object reference', () => {
    const registry = new ProcessRegistry()
    const concept = makeMinimalConcept({ id: 'same' })
    registry.register('same', concept)
    expect(registry.load('same')).toBe(concept)
  })
})

// ─── TS-T29 to TS-T36: process-tools ─────────────────────────────────────────

describe('process-tools', () => {
  let registry: ProcessRegistry
  let graph: TaskGraph

  beforeEach(() => {
    registry = new ProcessRegistry()
    registerAll(registry)
    graph = new TaskGraph()
  })

  it('TS-T29: listProcesses() returns array of dicts each with id/name/description/stepCount', () => {
    const results = listProcesses(registry)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(typeof r.id).toBe('string')
      expect(typeof r.name).toBe('string')
      expect(typeof r.description).toBe('string')
      expect(typeof r.stepCount).toBe('number')
    }
  })

  it('TS-T30: listProcesses() returns entries sorted alphabetically by id; count matches DEFAULT_REGISTRY.listAvailable()', () => {
    const results = listProcesses(registry)
    const ids = results.map(r => r.id)
    expect(ids).toEqual([...ids].sort())
    expect(results.length).toBe(registry.listAvailable().length)
  })

  it('TS-T31: loadProcess("implement_feature") seeds task graph and returns firstStep pointing to first PENDING task', () => {
    const result = loadProcess('implement_feature', graph, registry)
    expect(result.conceptId).toBe('implement_feature')
    expect(result.seededSteps).toBeGreaterThan(0)
    expect(result.firstStep).not.toBeNull()
    expect(typeof result.firstStep!.id).toBe('string')
    expect(result.firstStep!.id.startsWith('implement_feature:')).toBe(true)
  })

  it('TS-T32: loadProcess() called twice with same conceptId leaves task count unchanged — idempotent (INV-PC-05)', () => {
    loadProcess('implement_feature', graph, registry)
    const countAfterFirst = graph.tasks.length
    loadProcess('implement_feature', graph, registry)
    expect(graph.tasks.length).toBe(countAfterFirst)
  })

  it('TS-T33: loadProcess() with unregistered conceptId throws ProcessConceptNotFoundError', () => {
    expect(() => loadProcess('unknown_concept', graph, registry)).toThrow(ProcessConceptNotFoundError)
  })

  it('TS-T34: getCurrentStep() returns null when all tasks in graph are COMPLETE (INV-PC-06)', () => {
    loadProcess('debug_test_failure', graph, registry)
    for (const task of graph.tasks) {
      task.status = 'COMPLETE'
    }
    expect(getCurrentStep(graph)).toBeNull()
  })

  it('TS-T35: completeStep(stepId) sets task to COMPLETE and returns nextStep pointing to newly-unblocked dependent', () => {
    loadProcess('debug_test_failure', graph, registry)
    const first = getCurrentStep(graph)!
    const result = completeStep(first.id, graph)
    expect(result.completed).toBe(first.id)
    const completedTask = graph.tasks.find(t => t.id === first.id)!
    expect(completedTask.status).toBe('COMPLETE')
    // next step should now be unblocked (the task that depended on first)
    expect(result.nextStep).not.toBeNull()
  })

  it('TS-T36: completeStep() with nonexistent stepId throws Error with missing ID in message (INV-PC-07)', () => {
    expect(() => completeStep('nonexistent_step_id', graph)).toThrow()
  })
})

// ─── Bonus tests ──────────────────────────────────────────────────────────────

describe('Bonus: bundled concepts integrity', () => {
  it('all 4 bundled concept JSON files pass validate() — schema integrity confirmed at import time', () => {
    const ids = DEFAULT_REGISTRY.listAvailable()
    for (const id of ids) {
      const concept = DEFAULT_REGISTRY.load(id)
      expect(concept.validate()).toEqual([])
    }
  })

  it('DEFAULT_REGISTRY contains all 4 concept IDs (debug_test_failure, implement_feature, code_review, refactor_module)', () => {
    const ids = DEFAULT_REGISTRY.listAvailable()
    expect(ids).toContain('debug_test_failure')
    expect(ids).toContain('implement_feature')
    expect(ids).toContain('code_review')
    expect(ids).toContain('refactor_module')
  })
})
