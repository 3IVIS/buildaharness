import { describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from './state/experience-store.js'
import type { JournalEntry } from './state/memory-state.js'
import { DEFAULT_STRATEGY_ORDER } from './state/strategy-state.js'
import { buildStrategyOrdering } from './nodes/rollback-replan.js'
import { journalEntryFor, failureClassOf, recoveryAttempts, learnFromJournal, LEARNING_RATE, PRIOR } from './experience-learning.js'

const fail = (step: number, strategy: JournalEntry['action_class'], cls = ''): JournalEntry => journalEntryFor({ step, strategy: strategy as never, success: false, failureClass: cls })
const ok = (step: number, strategy: JournalEntry['action_class']): JournalEntry => journalEntryFor({ step, strategy: strategy as never, success: true, output: 'fine' })

describe('journalEntryFor / failureClassOf', () => {
  it('a success records "completed" and a short verbatim; a failure records failed:<class> and no verbatim', () => {
    expect(ok(1, 'DIRECT_EDIT')).toEqual({ step: 1, action_class: 'DIRECT_EDIT', outcome: 'completed', success: true, verbatim: 'fine' })
    expect(fail(2, 'TRACE_EXEC', 'timeout')).toEqual({ step: 2, action_class: 'TRACE_EXEC', outcome: 'failed:timeout', success: false })
  })

  it('an unmatched failure has the empty class — exactly the key buildStrategyOrdering looks up', () => {
    expect(failureClassOf(fail(1, 'DIRECT_EDIT'))).toBe('')
    expect(failureClassOf(fail(1, 'DIRECT_EDIT', 'timeout'))).toBe('timeout')
    expect(failureClassOf(ok(1, 'DIRECT_EDIT'))).toBeNull()
  })
})

describe('recoveryAttempts', () => {
  it('pairs each entry with the failure directly before it, in step order', () => {
    const journal = [ok(3, 'REIMPLEMENT'), fail(1, 'DIRECT_EDIT', 'timeout'), fail(2, 'TRACE_EXEC', 'timeout')]
    expect(recoveryAttempts(journal)).toEqual([
      { strategy: 'TRACE_EXEC', failureClass: 'timeout', success: false },
      { strategy: 'REIMPLEMENT', failureClass: 'timeout', success: true },
    ])
  })

  it('an entry that follows a success answers nothing, and an unknown strategy is ignored', () => {
    expect(recoveryAttempts([ok(1, 'DIRECT_EDIT'), ok(2, 'TRACE_EXEC')])).toEqual([])
    expect(recoveryAttempts([fail(1, 'DIRECT_EDIT'), ok(2, 'NOT_A_STRATEGY')])).toEqual([])
  })
})

describe('learnFromJournal', () => {
  it('first sight of a class initialises every strategy to the prior, then moves only the attempted one', () => {
    const store = new InMemoryExperienceStore()
    learnFromJournal([fail(1, 'DIRECT_EDIT', 'timeout'), ok(2, 'TRACE_EXEC')], store)
    const w = store.getStrategyWeights()
    expect(w['TRACE_EXEC:timeout']).toBeCloseTo(PRIOR * (1 - LEARNING_RATE) + LEARNING_RATE, 4)
    for (const s of DEFAULT_STRATEGY_ORDER.filter((x) => x !== 'TRACE_EXEC')) expect(w[`${s}:timeout`]).toBe(PRIOR)
  })

  it('a failed recovery attempt lowers that strategy for that class but leaves untried ones above it', () => {
    const store = new InMemoryExperienceStore()
    learnFromJournal([fail(1, 'DIRECT_EDIT', 'timeout'), fail(2, 'TRACE_EXEC', 'timeout')], store)
    const w = store.getStrategyWeights()
    expect(w['TRACE_EXEC:timeout']).toBeCloseTo(PRIOR * (1 - LEARNING_RATE), 4)
    expect(w['BROADER_SEARCH:timeout']).toBe(PRIOR)
    expect(buildStrategyOrdering('timeout', store).at(-1)).toBe('TRACE_EXEC')
  })

  it('learns across runs: the weights are a moving average, so a second success nudges further, never past 1', () => {
    const store = new InMemoryExperienceStore()
    for (let i = 0; i < 30; i++) learnFromJournal([fail(1, 'DIRECT_EDIT', 'timeout'), ok(2, 'REIMPLEMENT')], store)
    const w = store.getStrategyWeights()['REIMPLEMENT:timeout']
    expect(w).toBeGreaterThan(0.95)
    expect(w).toBeLessThanOrEqual(1)
  })

  it('what it learns is what the recovery ladder reads: the ordering for that class now starts with the strategy that worked', () => {
    const store = new InMemoryExperienceStore()
    expect(buildStrategyOrdering('timeout', store)[0]).toBe('DIRECT_EDIT') // nothing learned: the default order
    learnFromJournal([fail(1, 'DIRECT_EDIT', 'timeout'), ok(2, 'REIMPLEMENT')], store)
    expect(buildStrategyOrdering('timeout', store)[0]).toBe('REIMPLEMENT')
    expect(buildStrategyOrdering('some-other-class', store)[0]).toBe('DIRECT_EDIT') // other classes untouched
  })

  it('an unmatched failure learns under the empty class — the key the ladder uses for it', () => {
    const store = new InMemoryExperienceStore()
    learnFromJournal([fail(1, 'DIRECT_EDIT'), ok(2, 'BROADER_SEARCH')], store)
    expect(store.getStrategyWeights()['BROADER_SEARCH:']).toBeGreaterThan(PRIOR)
    expect(buildStrategyOrdering('', store)[0]).toBe('BROADER_SEARCH')
  })

  it('failure-class priors rise for a class seen this run and decay for one that was not; unmatched failures set none', () => {
    const store = new InMemoryExperienceStore()
    learnFromJournal([fail(1, 'DIRECT_EDIT', 'timeout'), ok(2, 'TRACE_EXEC')], store)
    expect(store.getClassPriors()).toEqual({ timeout: LEARNING_RATE })
    learnFromJournal([ok(1, 'DIRECT_EDIT')], store)
    expect(store.getClassPriors().timeout).toBeCloseTo(LEARNING_RATE * (1 - LEARNING_RATE), 4)
    const other = new InMemoryExperienceStore()
    learnFromJournal([fail(1, 'DIRECT_EDIT'), ok(2, 'TRACE_EXEC')], other)
    expect(other.getClassPriors()).toEqual({})
  })

  it('an empty journal or an unavailable store changes nothing', () => {
    const store = new InMemoryExperienceStore()
    learnFromJournal([], store)
    expect(store.getStrategyWeights()).toEqual({})
    const unavailable = { ...new InMemoryExperienceStore(), available: false, setStrategyWeight: () => { throw new Error('touched') } } as never
    expect(() => learnFromJournal([fail(1, 'DIRECT_EDIT'), ok(2, 'TRACE_EXEC')], unavailable)).not.toThrow()
  })
})
