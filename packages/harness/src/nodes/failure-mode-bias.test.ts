// The seeded default failure-mode library, and the recovery bias a confident match drives —
// mirrors adapter/harness/failure_modes.py's build_default_library() + recovery.py's
// apply_failure_mode_bias(), the TS side's own version of "a match actually changes what
// recovery tries next" instead of only labeling the failure.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rollbackAndReplan } from './rollback-replan.js'
import { StrategyState } from '../state/strategy-state.js'
import { FailureDiagnostics, FailureModeLibrary, DEFAULT_FAILURE_MODE_ENTRIES, resolveSemanticMatchStrategy } from '../state/failure-diagnostics.js'
import { TaskGraph } from '../state/task-graph.js'
import { WorldModel } from '../state/world-model.js'
import { CallerState } from '../state/caller-state.js'
import { UnavailableExperienceStore } from '../state/experience-store.js'
import { initializeHarness } from './initialize.js'

// These tests exercise the harness's lexical checks, which are off by default (lexical/lexical-off.ts),
// so this file switches them on.
let savedLexicalMode: string | undefined
beforeAll(() => {
  savedLexicalMode = process.env.HARNESS_LEXICAL_MODE
  process.env.HARNESS_LEXICAL_MODE = 'enabled'
})
afterAll(() => {
  if (savedLexicalMode === undefined) delete process.env.HARNESS_LEXICAL_MODE
  else process.env.HARNESS_LEXICAL_MODE = savedLexicalMode
})

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
    // Also exercises the requeue extension (rollback-replan.ts: failureModeSwitch requeues a
    // one-node graph's failed leaf, same as a supervisor directive already did) — without it,
    // this single-task graph would end after the first failure with nothing PENDING, and the
    // classification would never get a real second attempt to apply itself to.
    const seen: Array<{ taskId: string; failure_class: string; strategy: string }> = []
    let calls = 0
    const outcome = await new HarnessRuntime().run('objective', ['produce the answer'], {
      initialTasks: [{
        id: 'respond', description: 'respond', status: 'PENDING', risk_level: 'LOW',
        depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
      }],
      max_steps: 8,
      toolExecutors: {
        default: (toolCtx) => {
          calls += 1
          if (calls === 1) {
            toolCtx.failureDiagnostics!.failure_history.push({
              id: 'prior-1', timestamp: new Date().toISOString(),
              failure_class: 'unknown', description: 'a prior attempt at this also failed', context: {},
            })
            return { __harnessExecutionStatus: 'failed', error: 'injected: the remote peer never responded' }
          }
          // The requeued (second) attempt succeeds — a genuinely different call reaching this
          // toolExecutor at all is only possible once the task was actually requeued.
          return { __harnessExecutionStatus: 'complete', output: 'recovered answer' }
        },
      },
      semanticFailureMatcher: async () => ({
        failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade',
      }),
      onFailureModeSwitch: (e) => seen.push(e),
    })
    expect(seen).toEqual([{ taskId: 'respond', failure_class: 'TOOL_UNAVAILABLE_CASCADE', strategy: 'REIMPLEMENT' }])
    expect(calls).toBe(2)
    expect(outcome.status).toBe('complete')
  })
})

describe('rollbackAndReplan — failureModeSwitch requeues a one-node graph the same way a supervisor directive does', () => {
  // requeueFailedLeaves() only requeues a task whose graph status is already FAILED — a real
  // caller (execute.ts's recordFailure) transitions it there before calling rollbackAndReplan;
  // this test does the same so the graph is in the shape rollbackAndReplan actually receives it.
  const failedTask = () => ({ ...task(), status: 'FAILED' as const })
  const run = (matched: FailureDiagnostics['matched_pattern']) => {
    const fd = new FailureDiagnostics()
    fd.matched_pattern = matched
    return rollbackAndReplan(failedTask(), new StrategyState(), fd, new TaskGraph({ tasks: [failedTask()] }), new WorldModel(), new CallerState({ success_criteria: ['ship it'] }), new UnavailableExperienceStore())
  }

  it('requeues the failed leaf when a confident match with strategy_affinity picked the strategy', () => {
    const result = run({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.9, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' })
    expect(result.newTaskGraph.tasks.find((t) => t.id === 't1')?.status).toBe('PENDING')
  })

  it('does NOT requeue on the plain ladder walk (no match) — unchanged pre-existing behavior', () => {
    const result = run(null)
    expect(result.newTaskGraph.tasks.find((t) => t.id === 't1')?.status).not.toBe('PENDING')
  })

  it('does NOT requeue below the confidence threshold — unchanged pre-existing behavior', () => {
    const result = run({ failure_class: 'TOOL_UNAVAILABLE_CASCADE', confidence: 0.5, matched_pattern: 'tool-unavailable-cascade', strategy_affinity: 'REIMPLEMENT' })
    expect(result.newTaskGraph.tasks.find((t) => t.id === 't1')?.status).not.toBe('PENDING')
  })
})
