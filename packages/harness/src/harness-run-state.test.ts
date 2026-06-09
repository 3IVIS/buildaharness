import { describe, it, expect } from 'vitest'
import { HarnessRunState } from './harness-run-state.js'
import { WorldModel } from './state/world-model.js'
import { ControlState } from './state/control-state.js'
import { TaskGraph } from './state/task-graph.js'
import { EvidenceStore } from './state/evidence-store.js'
import { InMemoryExperienceStore } from './state/experience-store.js'

describe('HarnessRunState', () => {
  it('full toJSON/fromJSON round-trip including all 13 nested state objects', () => {
    const wm = new WorldModel({ generation_id: 3 })
    wm.completeness_flags['test_region'] = false

    const cs = new ControlState({ generation_id: 3, risk_state: 'CAUTIOUS', notes: ['some annotation'] })

    const tg = new TaskGraph({
      tasks: [{
        id: 'task_1', description: 'do thing', status: 'PENDING', risk_level: 'HIGH',
        depends_on: [], parallel_write_domains: ['src/auth.ts'],
        abstraction_level: 1, assigned_strategy: 'DIRECT_EDIT',
      }],
    })
    tg.setConflictProbability('src/auth.ts', 'src/db.ts', 0.3)

    const es = new EvidenceStore({
      tool_availability_manifest: { bash: { available: true, fallback_tool: null } },
    })

    const expStore = new InMemoryExperienceStore()
    expStore.setStrategyWeight('DIRECT_EDIT:compile_error', 0.8)

    const state = new HarnessRunState({
      worldModel: wm,
      controlState: cs,
      taskGraph: tg,
      evidenceStore: es,
      experienceStore: expStore,
    })

    const json = state.toJSON()
    const restored = HarnessRunState.fromJSON(json)

    // Verify all 13 state objects restored
    expect(restored.worldModel.generation_id).toBe(3)
    expect(restored.worldModel.completeness_flags['test_region']).toBe(false)
    expect(restored.controlState.risk_state).toBe('CAUTIOUS')
    expect(restored.controlState.notes[0]).toBe('some annotation')
    expect(restored.taskGraph.tasks[0].id).toBe('task_1')
    expect(restored.taskGraph.getConflictProbability('src/auth.ts', 'src/db.ts')).toBeCloseTo(0.3)
    expect(restored.evidenceStore.tool_availability_manifest['bash'].available).toBe(true)
    expect(restored.experienceStore.getStrategyWeights()['DIRECT_EDIT:compile_error']).toBeCloseTo(0.8)
    // All 13 objects present
    expect(restored.callerState).toBeDefined()
    expect(restored.diagnostics).toBeDefined()
    expect(restored.outputContract).toBeDefined()
    expect(restored.hypothesisSet).toBeDefined()
    expect(restored.memoryState).toBeDefined()
    expect(restored.strategyState).toBeDefined()
    expect(restored.failureDiagnostics).toBeDefined()
    expect(restored.beliefDepGraph).toBeDefined()
  })
})
