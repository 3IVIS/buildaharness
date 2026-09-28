// The seeded default failure-mode library, and the recovery bias a confident match drives —
// mirrors adapter/harness/failure_modes.py's build_default_library() + recovery.py's
// apply_failure_mode_bias(), the TS side's own version of "a match actually changes what
// recovery tries next" instead of only labeling the failure.

import { describe, it, expect } from 'vitest'
import { rollbackAndReplan } from './rollback-replan.js'
import { StrategyState } from '../state/strategy-state.js'
import { FailureDiagnostics, FailureModeLibrary, DEFAULT_FAILURE_MODE_ENTRIES, resolveSemanticMatchStrategy } from '../state/failure-diagnostics.js'
import { TaskGraph } from '../state/task-graph.js'
import { WorldModel } from '../state/world-model.js'
import { CallerState } from '../state/caller-state.js'
import { UnavailableExperienceStore } from '../state/experience-store.js'
import { initializeHarness } from './initialize.js'

const task = () => ({
  id: 't1',
  description: 'a task',
  status: 'RUNNING' as const,
  risk_level: 'LOW' as const,
  depends_on: [] as string[],
  parallel_write_domains: [] as string[],
  abstraction_level: 1,
  assigned_strategy: null,
})

describe('DEFAULT_FAILURE_MODE_ENTRIES — the seed', () => {
  it('a fresh run starts with the seed patterns; new FailureModeLibrary() alone stays empty (only initializeHarness seeds)', () => {
    const init = initializeHarness('do something', { successCriteria: ['done'], initialTasks: [task()] })
    expect(init.valid).toBe(true)
    expect(init.failureDiagnostics.failure_mode_library.getEntries()).toEqual(DEFAULT_FAILURE_MODE_ENTRIES)
    expect(new FailureModeLibrary().getEntries()).toEqual([])
  })

  it('an exact match against a seeded pattern carries its strategy_affinity', () => {
    const library = new FailureModeLibrary(DEFAULT_FAILURE_MODE_ENTRIES)
    const match = library.match(['the AV service unavailable, again, for the third call in a row'])
    expect(match).toMatchObject({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', strategy_affinity: 'REIMPLEMENT' })
  })
})

describe('rollbackAndReplan — failure-mode bias', () => {
  const run = (matched: FailureDiagnostics['matched_pattern']) => {
    const fd = new FailureDiagnostics()
    fd.matched_pattern = matched
    return rollbackAndReplan(task(), new StrategyState(), fd, new TaskGraph({ tasks: [task()] }), new WorldModel(), new CallerState({ success_criteria: ['ship it'] }), new UnavailableExperienceStore())
  }

  it('a confident match with a strategy_affinity jumps straight to it, skipping the plain ladder order', () => {
    // Plain DEFAULT_STRATEGY_ORDER would go DIRECT_EDIT -> TRACE_EXEC next; the affinity below
    // (REIMPLEMENT, 4th in the ladder) proves the bias is actually picking the affinity, not
    // coincidentally landing on the same strategy the unbiased walk would have chosen anyway.
    const result = run({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' })
    expect(result.newStrategyState.current_strategy).toBe('REIMPLEMENT')
    expect(result.newStrategyState.switch_triggers.at(-1)).toContain('failure_mode:TOOL_UNAVAILABLE_CASCADE -> REIMPLEMENT')
  })

  it('below the confidence threshold, the bias does not apply — falls back to the plain ladder', () => {
    const result = run({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.5, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' })
    expect(result.newStrategyState.current_strategy).toBe('TRACE_EXEC') // the plain next-after-DIRECT_EDIT step
  })

  it('a confident match with no strategy_affinity does not apply — falls back to the plain ladder', () => {
    const result = run({ failure_class: 'SOME_OTHER_CLASS', confidence: 0.95, matched_pattern: 'x' })
    expect(result.newStrategyState.current_strategy).toBe('TRACE_EXEC')
  })

  it('no match at all behaves exactly as before (plain ladder)', () => {
    const result = run(null)
    expect(result.newStrategyState.current_strategy).toBe('TRACE_EXEC')
  })
})

describe('resolveSemanticMatchStrategy — semantic matches get the same bias exact matches do', () => {
  it("looks up the semantic matcher's reported id in the library and returns its strategy_affinity", () => {
    const affinity = resolveSemanticMatchStrategy({ matched_pattern: 'circular-dependency' }, DEFAULT_FAILURE_MODE_ENTRIES)
    expect(affinity).toBe('BROADER_SEARCH')
  })

  it('returns undefined for an id not in the library (a stale/hallucinated id) rather than throwing', () => {
    expect(resolveSemanticMatchStrategy({ matched_pattern: 'no-such-id' }, DEFAULT_FAILURE_MODE_ENTRIES)).toBeUndefined()
  })

  it('returns undefined for a real entry that has no strategy_affinity of its own', () => {
    const entries = [{ id: 'diagnostic-only', failure_class: 'X', symptoms: ['x'], pattern_description: 'd' }]
    expect(resolveSemanticMatchStrategy({ matched_pattern: 'diagnostic-only' }, entries)).toBeUndefined()
  })
})
