import { describe, it, expect } from 'vitest'
import { InMemoryExperienceStore } from './state/experience-store.js'
import { journalEntryFor, learnFromJournal } from './experience-learning.js'
import { buildStrategyOrdering } from './nodes/rollback-replan.js'
import { wilsonLowerBound, recordAttempt, decidePromotion, MIN_ATTEMPTS, type StrategyEvent } from './strategy-evidence.js'
import type { JournalEntry } from './state/memory-state.js'

/** A one-recovery journal: a failure of `cls`, then `strategy` succeeding or failing. */
const recovery = (strategy: string, success: boolean, cls = 'timeout'): JournalEntry[] => [
  journalEntryFor({ step: 1, strategy: 'DIRECT_EDIT', success: false, failureClass: cls }),
  journalEntryFor({ step: 2, strategy: strategy as never, success, output: 'x' }),
]

describe('wilsonLowerBound', () => {
  it('is 0 for no data and grows with sample at the same rate', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
    expect(wilsonLowerBound(1, 1)).toBeLessThan(wilsonLowerBound(10, 10))
    expect(wilsonLowerBound(10, 10)).toBeLessThan(1)
  })
})

describe('recordAttempt', () => {
  it('keeps run references and recent outcomes bounded, and restarts on a different context', () => {
    let e = recordAttempt(undefined, { success: true, runId: 'r1', now: 1, context: 'web' })
    for (let i = 0; i < 40; i++) e = recordAttempt(e, { success: true, runId: `r${i + 2}`, now: 2, context: 'web' })
    expect(e.attempts).toBe(41)
    expect(e.runIds.length).toBeLessThanOrEqual(20)
    expect(e.recent.length).toBeLessThanOrEqual(10)
    const other = recordAttempt(e, { success: false, now: 3, context: 'files' })
    expect(other.attempts).toBe(1)
    expect(other.context).toBe('files')
  })
})

describe('sample rule', () => {
  it('a single lucky success is recorded, not used (legacy rule would have moved the weight)', () => {
    const sample = new InMemoryExperienceStore()
    const events: StrategyEvent[] = []
    learnFromJournal(recovery('TRACE_EXEC', true), sample, { rule: 'sample', runId: 'r1', onEvent: (e) => events.push(e) })
    expect(sample.getStrategyEvidence()['TRACE_EXEC:timeout'].attempts).toBe(1)
    expect(sample.getStrategyWeights()).toEqual({})
    expect(buildStrategyOrdering('timeout', sample)).toEqual(buildStrategyOrdering('timeout', new InMemoryExperienceStore()))
    expect(events).toEqual([])

    const legacy = new InMemoryExperienceStore()
    learnFromJournal(recovery('TRACE_EXEC', true), legacy)
    expect(legacy.getStrategyWeights()['TRACE_EXEC:timeout']).toBeGreaterThan(0.5)
  })

  it('promotes after enough consistent successes, with an event carrying the numbers', () => {
    const store = new InMemoryExperienceStore()
    const events: StrategyEvent[] = []
    for (let i = 0; i < 12; i++) learnFromJournal(recovery('TRACE_EXEC', true), store, { rule: 'sample', runId: `r${i}`, onEvent: (e) => events.push(e) })
    expect(events.map((e) => e.type)).toEqual(['strategy_promoted'])
    expect(events[0].attempts).toBeGreaterThanOrEqual(MIN_ATTEMPTS)
    expect(events[0].lowerBound).toBeGreaterThan(events[0].baseline)
    expect(buildStrategyOrdering('timeout', store)[0]).toBe('TRACE_EXEC')
  })

  it('does not promote a strategy that succeeds no more than its alternative', () => {
    const store = new InMemoryExperienceStore()
    for (let i = 0; i < 12; i++) {
      learnFromJournal(recovery('TRACE_EXEC', i % 2 === 0), store, { rule: 'sample' })
      learnFromJournal(recovery('BROADER_SEARCH', i % 2 === 0), store, { rule: 'sample' })
    }
    expect(store.getStrategyWeights()).toEqual({})
  })

  it('demotes a promoted strategy after a failure streak, and says so', () => {
    const store = new InMemoryExperienceStore()
    const events: StrategyEvent[] = []
    for (let i = 0; i < 12; i++) learnFromJournal(recovery('TRACE_EXEC', true), store, { rule: 'sample' })
    for (let i = 0; i < 3; i++) learnFromJournal(recovery('TRACE_EXEC', false), store, { rule: 'sample', onEvent: (e) => events.push(e) })
    expect(events.map((e) => e.type)).toEqual(['strategy_demoted'])
    expect(store.getStrategyWeights()['TRACE_EXEC:timeout']).toBe(0)
  })

  it('scopes evidence to the failure class: a promotion for timeout does not rank another class', () => {
    const store = new InMemoryExperienceStore()
    for (let i = 0; i < 12; i++) learnFromJournal(recovery('TRACE_EXEC', true), store, { rule: 'sample' })
    expect(buildStrategyOrdering('rate_limit', store)).toEqual(buildStrategyOrdering('rate_limit', new InMemoryExperienceStore()))
  })

  it('evidence survives a toJSON/fromJSON round trip', () => {
    const store = new InMemoryExperienceStore()
    learnFromJournal(recovery('TRACE_EXEC', true), store, { rule: 'sample', runId: 'r1' })
    const back = InMemoryExperienceStore.fromJSON(store.toJSON())
    expect(back.getStrategyEvidence()['TRACE_EXEC:timeout'].runIds).toEqual(['r1'])
  })
})

describe('trap: succeeds once by luck, then fails (harmful-promotion rate)', () => {
  /** Deterministic simulation: the trap strategy wins its first attempt, then fails on every later family. */
  function harmfulPromotions(rule: 'single' | 'sample'): number {
    let harmful = 0
    const store = new InMemoryExperienceStore()
    for (let family = 0; family < 20; family++) {
      const rankedFirst = buildStrategyOrdering('timeout', store)[0] === 'TRACE_EXEC'
      const evidence = store.getStrategyEvidence()['TRACE_EXEC:timeout']?.attempts ?? 0
      const lucky = family === 0
      if (rankedFirst && evidence < MIN_ATTEMPTS && !lucky) harmful++
      learnFromJournal(recovery('TRACE_EXEC', lucky), store, { rule })
    }
    return harmful
  }
  it('the sample rule avoids the harm the one-success rule causes', () => {
    expect(harmfulPromotions('single')).toBeGreaterThan(0)
    expect(harmfulPromotions('sample')).toBe(0)
  })
})

describe('decidePromotion', () => {
  it('needs the minimum attempts even with a perfect record', () => {
    let e = undefined as ReturnType<typeof recordAttempt> | undefined
    for (let i = 0; i < MIN_ATTEMPTS - 1; i++) e = recordAttempt(e, { success: true, now: i, context: '' })
    expect(decidePromotion(e!, []).promoted).toBe(false)
  })
})
