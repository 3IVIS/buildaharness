import { describe, it, expect } from 'vitest'
import { WorldModel } from '../state/world-model.js'
import { TaskGraph } from '../state/task-graph.js'
import { StrategyState, DEFAULT_STRATEGY_ORDER, type StrategyType } from '../state/strategy-state.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { CallerState } from '../state/caller-state.js'
import { InMemoryExperienceStore } from '../state/experience-store.js'
import { rollbackAndReplan, buildStrategyOrdering, pickLearnedStrategy } from './rollback-replan.js'

type Status = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED'
const task = (id: string, status: Status = 'FAILED') => ({
  id,
  description: 'a task',
  status,
  risk_level: 'LOW' as const,
  depends_on: [] as string[],
  parallel_write_domains: [] as string[],
  abstraction_level: 1,
  assigned_strategy: null,
})

/** A store whose learned ranking puts BROADER_SEARCH first and DIRECT_EDIT third for the unmatched-failure class ''. */
function learnedStore(): InMemoryExperienceStore {
  const store = new InMemoryExperienceStore()
  store.setStrategyWeight('BROADER_SEARCH:', 0.9)
  store.setStrategyWeight('TRACE_EXEC:', 0.7)
  store.setStrategyWeight('DIRECT_EDIT:', 0.5)
  return store
}

function switchOnce(store: InMemoryExperienceStore, learnedLadder: boolean, ss = new StrategyState()) {
  const t = task('t1')
  return rollbackAndReplan(t, ss, new FailureDiagnostics(), new TaskGraph({ tasks: [t] }), new WorldModel(), new CallerState(), store, undefined, null, false, learnedLadder)
}

describe('pickLearnedStrategy', () => {
  const ranking: StrategyType[] = ['BROADER_SEARCH', 'TRACE_EXEC', 'DIRECT_EDIT', 'REIMPLEMENT', 'MINIMAL_FIX', 'ESCALATE']
  it('the first switch takes the top-ranked strategy, even though the current one is ranked above the next-after-current slot', () => {
    expect(pickLearnedStrategy(ranking, 'DIRECT_EDIT', 0)).toBe('BROADER_SEARCH')
  })
  it('steps past the strategy already in effect, and walks down the ranking on later switches', () => {
    expect(pickLearnedStrategy(ranking, 'BROADER_SEARCH', 0)).toBe('TRACE_EXEC')
    expect(pickLearnedStrategy(ranking, 'BROADER_SEARCH', 1)).toBe('TRACE_EXEC')
    expect(pickLearnedStrategy(ranking, 'TRACE_EXEC', 2)).toBe('DIRECT_EDIT')
  })
  it('stays on the last entry once the ranking is exhausted', () => {
    expect(pickLearnedStrategy(ranking, 'ESCALATE', 9)).toBe('ESCALATE')
  })
})

describe('rollbackAndReplan with the learned ladder', () => {
  it('the premise: the default next-after-current rule skips the learned winner', () => {
    expect(buildStrategyOrdering('', learnedStore())[0]).toBe('BROADER_SEARCH')
    const r = switchOnce(learnedStore(), false)
    expect(r.newStrategyState.current_strategy).toBe(buildStrategyOrdering('', learnedStore())[3])
    expect(r.newStrategyState.current_strategy).not.toBe('BROADER_SEARCH')
    expect(r.learnedSwitch).toBeUndefined()
  })

  it('flag on + learned ranking: the learned winner is tried first and the switch is reported', () => {
    const r = switchOnce(learnedStore(), true)
    expect(r.newStrategyState.current_strategy).toBe('BROADER_SEARCH')
    expect(r.learnedSwitch).toEqual({ failure_class: '', strategy: 'BROADER_SEARCH' })
  })

  it('flag on but nothing learned (default order): identical to the flag-off result, and no event', () => {
    const off = switchOnce(new InMemoryExperienceStore(), false)
    const on = switchOnce(new InMemoryExperienceStore(), true)
    expect(on.newStrategyState.current_strategy).toBe(off.newStrategyState.current_strategy)
    expect(on.newStrategyState.current_strategy).toBe(DEFAULT_STRATEGY_ORDER[1])
    expect(on.learnedSwitch).toBeUndefined()
  })
})

describe('precedence: a learned ranking outranks a curated failure-mode match, but not a supervisor redirect', () => {
  const curated = () => {
    const fd = new FailureDiagnostics()
    fd.matched_pattern = { failure_class: 'timeout', confidence: 0.9, matched_pattern: 'x', strategy_affinity: 'REIMPLEMENT' } as never
    return fd
  }
  const learnedForTimeout = () => {
    const store = new InMemoryExperienceStore()
    store.setStrategyWeight('BROADER_SEARCH:timeout', 0.9)
    store.setStrategyWeight('TRACE_EXEC:timeout', 0.7)
    return store
  }
  const go = (learned: boolean, directive: unknown = null) => {
    const t = task('t1')
    return rollbackAndReplan(t, new StrategyState(), curated(), new TaskGraph({ tasks: [t] }), new WorldModel(), new CallerState(), learnedForTimeout(), undefined, directive as never, false, learned)
  }

  it('flag off: the curated match wins (unchanged)', () => {
    const r = go(false)
    expect(r.newStrategyState.current_strategy).toBe('REIMPLEMENT')
    expect(r.failureModeSwitch).toBeDefined()
    expect(r.learnedSwitch).toBeUndefined()
  })
  it('flag on with weights for the class: the learned winner is chosen and only the learned switch is reported', () => {
    const r = go(true)
    expect(r.newStrategyState.current_strategy).toBe('BROADER_SEARCH')
    expect(r.learnedSwitch).toEqual({ failure_class: 'timeout', strategy: 'BROADER_SEARCH' })
    expect(r.failureModeSwitch).toBeUndefined()
    expect(r.newStrategyState.switch_triggers.some((x) => x.startsWith('learned:timeout'))).toBe(true)
  })
  it('flag on but no weights for the class: the curated match still wins', () => {
    const t = task('t1')
    const r = rollbackAndReplan(t, new StrategyState(), curated(), new TaskGraph({ tasks: [t] }), new WorldModel(), new CallerState(), new InMemoryExperienceStore(), undefined, null, false, true)
    expect(r.newStrategyState.current_strategy).toBe('REIMPLEMENT')
    expect(r.learnedSwitch).toBeUndefined()
  })
  it('a supervisor redirect still outranks the learned ranking', () => {
    const r = go(true, { action: 'REDIRECT_STRATEGY', strategy_hint: 'MINIMAL_FIX', rationale: 'r' })
    expect(r.newStrategyState.current_strategy).toBe('MINIMAL_FIX')
    expect(r.learnedSwitch).toBeUndefined()
  })
})

describe('retryFailedTask re-queues the failed leaf after the switch', () => {
  const failedOf = (retry: boolean, extra: ReturnType<typeof task>[] = []) => {
    const t = task('t1')
    const g = new TaskGraph({ tasks: [t, ...extra] })
    const r = rollbackAndReplan(t, new StrategyState(), new FailureDiagnostics(), g, new WorldModel(), new CallerState(), null, undefined, null, false, false, retry)
    return r.newTaskGraph.tasks.find((x) => x.id === 't1')!.status
  }
  it('off: a lone failed task is left FAILED (nothing re-runs under the new strategy)', () => {
    expect(failedOf(false)).toBe('FAILED')
  })
  it('on: the failed task is PENDING again', () => {
    expect(failedOf(true)).toBe('PENDING')
  })
  it('on: a failed task that has a dependent is re-queued too (the dependent cannot run while it stays FAILED)', () => {
    const dependent = { ...task('t2', 'PENDING'), depends_on: ['t1'] }
    const t = task('t1')
    const mk = (retry: boolean) =>
      rollbackAndReplan(t, new StrategyState(), new FailureDiagnostics(), new TaskGraph({ tasks: [{ ...t }, { ...dependent }] }), new WorldModel(), new CallerState(), null, undefined, null, false, false, retry)
    expect(mk(false).newTaskGraph.tasks.find((x) => x.id === 't1')!.status).toBe('FAILED')
    expect(mk(true).newTaskGraph.tasks.find((x) => x.id === 't1')!.status).toBe('PENDING')
  })
  it('on: also when other tasks are still pending (the old rule only requeued when nothing was pending)', () => {
    const other = task('t2', 'PENDING')
    expect(failedOf(false, [other])).toBe('FAILED')
    expect(failedOf(true, [other])).toBe('PENDING')
  })
})
