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

describe('rollbackAndReplan — failureModeSwitch (what a host would surface to the proposer)', () => {
  const run = (matched: FailureDiagnostics['matched_pattern']) => {
    const fd = new FailureDiagnostics()
    fd.matched_pattern = matched
    return rollbackAndReplan(task(), new StrategyState(), fd, new TaskGraph({ tasks: [task()] }), new WorldModel(), new CallerState({ success_criteria: ['ship it'] }), new UnavailableExperienceStore())
  }

  it('is set when the failure-mode bias picked the strategy', () => {
    const result = run({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' })
    expect(result.failureModeSwitch).toEqual({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', strategy: 'REIMPLEMENT' })
  })

  it('is absent for the plain ladder walk (no match)', () => {
    expect(run(null).failureModeSwitch).toBeUndefined()
  })

  it('is absent below the confidence threshold', () => {
    const result = run({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.5, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' })
    expect(result.failureModeSwitch).toBeUndefined()
  })
})

describe('HarnessRuntime — onFailureModeSwitch fires end to end through a real run', () => {
  it('fires when a confident, strategy_affinity-bearing match is on record at the moment a task fails', async () => {
    const { HarnessRuntime } = await import('../harness-runtime.js')
    // Realistic shape: the exact match can't fire (the error text is a paraphrase, matching no
    // curated phrase, same as a real injected-failure benchmark symptom) — only the stubbed
    // semantic matcher can classify it. The semantic gate also requires failure_history.length >
    // 0, so — same technique harness-runtime-stall.test.ts's seedThenFail uses — the toolExecutor
    // seeds a prior failure_history entry directly before returning FAILED, rather than relying
    // on a second natural retry (a single-task graph's first failure ends the run; it is not
    // auto-requeued without a supervisor directive — see requeueLeafOnLocal).
    const seen: Array<{ taskId: string; failure_class: string; strategy: string }> = []
    await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [{
        id: 'respond', description: 'respond', status: 'PENDING', risk_level: 'LOW',
        depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
      }],
      max_steps: 8,
      toolExecutors: {
        default: (toolCtx) => {
          toolCtx.failureDiagnostics!.failure_history.push({
            id: 'prior-1', timestamp: new Date().toISOString(),
            failure_class: 'unknown', description: 'a prior attempt at this also failed', context: {},
          })
          return { __harnessExecutionStatus: 'failed', error: 'injected: the remote peer never responded' }
        },
      },
      semanticFailureMatcher: async () => ({
        failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade',
      }),
      onFailureModeSwitch: (e) => seen.push(e),
    }).catch(() => {
      // The run may still end in escalation once the (now-classified) failure exhausts the
      // single-task graph's retry — the callback firing before that is what this test asserts.
    })
    expect(seen).toEqual([{ taskId: 'respond', failure_class: 'TOOL_UNAVAILABLE_CASCADE', strategy: 'REIMPLEMENT' }])
  })
})
