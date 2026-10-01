import { describe, it, expect } from 'vitest'
import { WorldModel } from '../state/world-model.js'
import { TaskGraph } from '../state/task-graph.js'
import { StrategyState, DEFAULT_STRATEGY_ORDER, type StrategyType } from '../state/strategy-state.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { CallerState } from '../state/caller-state.js'
import { InMemoryExperienceStore } from '../state/experience-store.js'
import { rollbackAndReplan, buildStrategyOrdering, pickLearnedStrategy } from './rollback-replan.js'

const task = (id: string) => ({
  id,
  description: 'a task',
  status: 'RUNNING' as const,
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
