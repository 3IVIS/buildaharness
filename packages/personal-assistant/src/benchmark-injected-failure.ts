/**
 * **Eval harness only** — the mechanism behind `TurnOptions.__benchmarkInjectedFailure`.
 *
 * The Trajectory Supervisor (`plans/harness_trajectory_supervisor_plan.html`, ADR-005) is
 * only consulted on the `cannotMakeProgress()` stall edge. A single benchmark turn in the
 * personal-assistant path resolves in 1–2 harness iterations and never reaches that edge,
 * so `supervisorOn` is behaviourally identical to `flagOn` and the S7 Rule-6 delta cannot
 * be measured (see `plans/harness_trajectory_supervisor_plan.html` S7 note).
 *
 * This wrapper manufactures a genuine stall at the proposer seam: on the first call it
 * seeds `seedFailures` recurring same-class records into the run's live
 * `failureDiagnostics.failure_history` (enough for `failureRecurring()` to trip) and an
 * observation, then reports a failed execution for the first `failIterations` iterations.
 * The harness's own post-verify branch then sees the recurrence, consults the supervisor,
 * and runs its recovery ladder (a GLOBAL task-graph rebuild). Later iterations over the
 * rebuilt graph get the first real proposer result, replayed from cache so each injected
 * task costs at most one real backend call.
 *
 * `ToolExecutorContext` explicitly sanctions a proposer mutating the harness's own live
 * state (see its doc comment in `@buildaharness/harness`'s `execute.ts`).
 */
import type { ToolExecutorContext } from '@buildaharness/harness'

export interface InjectedFailureOptions {
  /** How many leading harness iterations report a failed execution. */
  failIterations: number
  /** Recurring same-class `failure_history` records seeded on the first call. */
  seedFailures: number
}

const INJECTED_FAILURE_CLASS = 'injected_persistent_tool_failure'
const INJECTED_ERROR = 'injected: persistent tool failure (ETIMEDOUT)'

type Proposer = (toolCtx: ToolExecutorContext) => unknown | Promise<unknown>

export function wrapProposerWithInjectedFailure(
  realProposer: Proposer,
  opts: InjectedFailureOptions,
): (toolCtx: ToolExecutorContext) => Promise<unknown> {
  let calls = 0
  let realResult: unknown
  let realResultCached = false

  return async (toolCtx: ToolExecutorContext): Promise<unknown> => {
    calls += 1

    if (calls === 1) {
      const now = new Date().toISOString()
      for (let k = 0; k < opts.seedFailures; k++) {
        toolCtx.failureDiagnostics?.failure_history.push({
          id: `inj-${k}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: now,
          failure_class: INJECTED_FAILURE_CLASS,
          description: 'injected: persistent read failure (request timed out)',
          context: { injected: true },
        })
      }
      // Pin the matched failure class so rollbackAndReplan's own record carries it too —
      // otherwise its 'unknown' record lands in failureRecurring()'s last-3 window and the
      // stall re-check inside the ladder degrades the GLOBAL rebuild back to LOCAL (which
      // cannot re-queue the single failed task → the run stops with nothing PENDING).
      if (toolCtx.failureDiagnostics) {
        toolCtx.failureDiagnostics.matched_pattern = {
          failure_class: INJECTED_FAILURE_CLASS,
          confidence: 1,
          matched_pattern: 'injected',
        }
      }
      toolCtx.worldModel.observations.push({
        id: `inj-obs-${Math.random().toString(36).slice(2, 8)}`,
        content: `SYSTEM_ERROR: ${INJECTED_ERROR}`,
        source: 'execution_engine',
        recorded_at: now,
      })
    }

    if (calls <= opts.failIterations) {
      return { __harnessExecutionStatus: 'failed', error: INJECTED_ERROR }
    }

    if (!realResultCached) {
      realResult = await realProposer(toolCtx)
      realResultCached = true
      return realResult
    }
    // Rebuilt-task iterations: replay the one real answer as a completed execution so the
    // run converges without paying for another backend call.
    return { __harnessExecutionStatus: 'complete', output: extractOutput(realResult) }
  }
}

function extractOutput(result: unknown): unknown {
  if (result && typeof result === 'object' && '__harnessExecutionStatus' in result) {
    return (result as { output?: unknown }).output ?? null
  }
  return result ?? null
}
