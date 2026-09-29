import { describe, it, expect } from 'vitest'
import { WorldModel, BeliefDepGraph } from '../state/world-model.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { Diagnostics } from '../state/diagnostics.js'
import { TaskGraph, type Task } from '../state/task-graph.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { updateDiagnostics } from './update-diagnostics.js'
import { EXECUTION_RATIO_MIN_ATTEMPTS } from '../_core-generated.js'

// execution_ratio_min_attempts (spec/harness-core.json): the two task-ratio dimensions stay neutral
// until enough tasks have been attempted, so one failed attempt on a one-task graph is not read as
// progress 0 / oscillation 1 (both past CRITICAL_THRESHOLD → Tier 2 DENY before recovery can retry).

const task = (id: string, status: Task['status']): Task => ({
  id, description: id, status, risk_level: 'LOW', depends_on: [], parallel_write_domains: [], abstraction_level: 0, assigned_strategy: null,
})

function execution(statuses: Array<Task['status']>) {
  const diagnostics = new Diagnostics()
  const tg = new TaskGraph({ tasks: statuses.map((s, i) => task(`t${i}`, s)), changed: false })
  updateDiagnostics(new WorldModel(), new HypothesisSet(), tg, new FailureDiagnostics(), new BeliefDepGraph(), diagnostics)
  return diagnostics.execution_health
}

describe('execution ratios need a minimum number of attempts', () => {
  it('the constant is 3', () => {
    expect(EXECUTION_RATIO_MIN_ATTEMPTS).toBe(3)
  })

  it('one failed attempt on a one-task graph reads neutral, not 0 / 1', () => {
    const h = execution(['FAILED'])
    expect(h.progress_rate).toBe(1)
    expect(h.oscillation_score).toBe(0)
  })

  it('two failed attempts (still below the minimum) read neutral', () => {
    const h = execution(['FAILED', 'FAILED', 'PENDING'])
    expect(h.progress_rate).toBe(1)
    expect(h.oscillation_score).toBe(0)
  })

  it('at the minimum the ratios apply: 3 attempts, none completed → progress 0, oscillation 1', () => {
    const h = execution(['FAILED', 'FAILED', 'FAILED'])
    expect(h.progress_rate).toBe(0)
    expect(h.oscillation_score).toBe(1)
  })

  it('at the minimum with a mix: 2 of 3 completed → progress 2/3, oscillation 1/3', () => {
    const h = execution(['COMPLETE', 'COMPLETE', 'FAILED'])
    expect(h.progress_rate).toBeCloseTo(2 / 3)
    expect(h.oscillation_score).toBeCloseTo(1 / 3)
  })

  it('pending tasks are not attempts: 1 failed + 5 pending stays neutral', () => {
    const h = execution(['FAILED', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING'])
    expect(h.progress_rate).toBe(1)
    expect(h.oscillation_score).toBe(0)
  })
})
