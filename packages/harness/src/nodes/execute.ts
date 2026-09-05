import type { WorldModel } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { TaskGraph, Task } from '../state/task-graph.js'
import type { MemoryState } from '../state/memory-state.js'
import type { BeliefDepGraph } from '../state/world-model.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import type { ControlState } from '../state/control-state.js'
import { applyTaskOutcome } from './apply-task-outcome.js'

export type ReversibilityStrategy = 'snapshot' | 'git-revert' | 'patch-rollback' | 'ephemeral'

/**
 * Phase D1: what a toolFn's return means for the task's lifecycle. 'complete' is what every
 * toolFn produced before this phase (a plain, non-throwing return) and stays the default for
 * one — driveMainLoop marks the task COMPLETE exactly as it always has. 'continue' is new: the
 * task stays RUNNING and the harness re-executes it on the next main-loop iteration (via the
 * same pendingProposal suspend point Phase 3 built, so a real process restart between two
 * 'continue' steps resumes correctly — see PendingProposalData.kind). 'failed' from a
 * non-throwing return gets the identical SYSTEM_ERROR evidence + task-FAILED treatment a thrown
 * error already gets — a toolFn that already distinguishes its own failure modes doesn't need to
 * throw just to get that.
 */
export type ExecutionStatus = 'continue' | 'complete' | 'failed'

export interface ExecutionResult {
  success: boolean
  output: unknown
  error: string | null
  strategy: ReversibilityStrategy
  rollback_ref: string | null
  status: ExecutionStatus
}

/**
 * Opt-in structured return for a toolFn that needs to signal 'continue' or a non-throwing
 * 'failed' — a toolFn that just returns a plain value (every toolFn written before Phase D1)
 * is unaffected and always resolves to status 'complete', exactly as before.
 */
export interface ContinuableExecutionOutcome {
  __harnessExecutionStatus: ExecutionStatus
  output?: unknown
  error?: string
}

function isContinuableOutcome(value: unknown): value is ContinuableExecutionOutcome {
  if (typeof value !== 'object' || value === null || !('__harnessExecutionStatus' in value)) return false
  const status = (value as { __harnessExecutionStatus: unknown }).__harnessExecutionStatus
  return status === 'continue' || status === 'complete' || status === 'failed'
}

/**
 * Phase D2: a marker a toolFn's thrown error can carry to mean "this isn't a real execution
 * failure" — e.g. a harness-driven proposer throwing this to signal a turn needs a human
 * approval (write_file/run_shell_command/send_email) or has hit its own escalation, neither of
 * which is "the tool broke." execute() rethrows it unexamined below instead of recording
 * SYSTEM_ERROR evidence + a task-FAILED transition, the same way EscalationHalt already
 * propagates untouched out of the main loop rather than being treated as a tool error.
 */
export interface HarnessPauseSignal {
  __harnessPause: true
}

export function isHarnessPauseSignal(value: unknown): value is HarnessPauseSignal {
  return typeof value === 'object' && value !== null && (value as { __harnessPause?: unknown }).__harnessPause === true
}

export interface ProposedExecutionChange {
  description?: string
  change_type?: 'read-only' | 'schema' | 'infra' | 'file_mutation'
  required_resources?: string[]
  required_state_structures?: string[]
}

export interface ExecutionContext {
  worldModel: WorldModel
  evidenceStore: EvidenceStore
  taskGraph: TaskGraph
  currentTask: Task
  memoryState: MemoryState
  beliefDepGraph?: BeliefDepGraph
  planToolWorkflow?: () => void
  /**
   * R2 of the D2 one-loop-rewire follow-up plan (plans/harness_d2_one_loop_rewire_plan.html):
   * this main-loop iteration's already-resolved ControlState (see driveMainLoop's actionGate
   * block, which runs before execute() is ever called) — optional so every pre-existing test
   * that builds an ExecutionContext by hand without one keeps compiling unchanged. Threaded
   * through to toolFn as ToolExecutorContext below so a harness-driven proposer can fold its own
   * tool-call bookkeeping into the harness's own live state instead of maintaining a second,
   * parallel ControlState (see personal-assistant's tool-control-plane.ts, which this was written
   * to let go of duplicating).
   */
  controlState?: ControlState
  diagnostics?: Diagnostics
  failureDiagnostics?: FailureDiagnostics
}

/**
 * R2 of the D2 one-loop-rewire follow-up plan: what a toolFn actually receives when
 * driveMainLoop calls it. A toolFn written before this phase ignores its argument entirely
 * (JS/TS both allow calling a function with more arguments than it declares) and is completely
 * unaffected. A harness-driven proposer (personal-assistant's one-loop-proposer machinery) reads
 * `controlState` to gate its own tool calls (tool-policy.ts's evaluateToolPolicy) against the
 * exact same ControlState driveMainLoop's own actionGate will re-resolve on the next iteration —
 * and, when it records a tool outcome, mutates `worldModel`/`evidenceStore`/`diagnostics`/
 * `failureDiagnostics` directly (the harness's own live state for this run), so that bookkeeping
 * feeds the *same* resolveControlState() call the harness's main loop already makes each
 * iteration instead of a second, disconnected structure.
 */
export interface ToolExecutorContext {
  worldModel: WorldModel
  evidenceStore: EvidenceStore
  controlState?: ControlState
  diagnostics?: Diagnostics
  failureDiagnostics?: FailureDiagnostics
}

const UNVERIFIED_EDGE_RATIO_THRESHOLD = 0.5

function selectReversibilityStrategy(change: ProposedExecutionChange): ReversibilityStrategy {
  const changeType = change.change_type ?? 'file_mutation'
  if (changeType === 'read-only') return 'ephemeral'
  if (changeType === 'schema' || changeType === 'infra') return 'snapshot'
  return 'patch-rollback'
}

function makeRollbackRef(): string {
  return Math.random().toString(36).slice(2, 10)
}

interface SymptomPattern {
  test: (lowerMessage: string) => boolean
  symptom: string
}

// Ordered most-specific first — the first matching pattern wins.
const SYSTEM_ERROR_SYMPTOM_PATTERNS: SymptomPattern[] = [
  { test: (m) => m.includes('enoent') || m.includes('no such file or directory'), symptom: 'file not found' },
  { test: (m) => m.includes('etimedout') || m.includes('timed out') || m.includes('timeout'), symptom: 'request timed out' },
  { test: (m) => m.includes('econnrefused') || m.includes('connection refused'), symptom: 'connection refused' },
  { test: (m) => m.includes('eacces') || m.includes('permission denied'), symptom: 'permission denied' },
  { test: (m) => m.includes('enotfound') || m.includes('getaddrinfo'), symptom: 'host not found' },
  { test: (m) => m.includes('econnreset'), symptom: 'connection reset' },
  { test: (m) => m.includes('404') || m.includes('not found'), symptom: 'not found' },
  { test: (m) => m.includes('401') || m.includes('403') || m.includes('unauthorized') || m.includes('forbidden'), symptom: 'access denied' },
  { test: (m) => /\b5\d{2}\b/.test(m) || m.includes('internal server error'), symptom: 'server error' },
  { test: (m) => m.includes('exited with code') || /non-?zero exit/.test(m), symptom: 'command failed' },
]

// Raw error text (e.g. "ENOENT: no such file or directory") rarely shares literal
// vocabulary with a curated FailureModeEntry symptom phrase (e.g. "file not found"),
// so this bridges the two before SYSTEM_ERROR evidence is written.
//
// Accepted as-is (plans/lexical_functions_hardening_plan.html Phase 3 step 3): unlike the
// user-phrasing lexical checks elsewhere in this plan, these tokens are largely language-agnostic
// OS/protocol vocabulary (errno names, HTTP status codes), not natural language a non-English or
// paraphrased-English speaker would author differently — the language/rephrasing framing doesn't
// map cleanly onto it. The real, ongoing cost is a new tool surfacing an error format not in this
// list falling through unclassified (returns null, degrades gracefully); worth a note, not a
// redesign.
function classifySystemErrorSymptom(message: string): string | null {
  const lower = message.toLowerCase()
  for (const { test, symptom } of SYSTEM_ERROR_SYMPTOM_PATTERNS) {
    if (test(lower)) return symptom
  }
  return null
}

export async function execute(
  proposedChange: ProposedExecutionChange,
  toolFn: ((toolCtx: ToolExecutorContext) => unknown | Promise<unknown>),
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const strategy = selectReversibilityStrategy(proposedChange)
  const taskId = ctx.currentTask.id
  let rollback_ref: string | null = null

  if (strategy !== 'ephemeral') {
    rollback_ref = `${strategy}-${makeRollbackRef()}`
    if (strategy === 'snapshot') {
      ctx.memoryState.rollback_points.push({
        id: rollback_ref,
        step: ctx.memoryState.rollback_points.length,
        description: proposedChange.description ?? 'snapshot',
        serialised_state: JSON.stringify(ctx.worldModel.toJSON()),
      })
    } else {
      ctx.memoryState.rollback_points.push({
        id: rollback_ref,
        step: ctx.memoryState.rollback_points.length,
        description: proposedChange.description ?? strategy,
        serialised_state: '',
      })
    }
  }

  // Dep graph refresh check before executing
  if (
    ctx.beliefDepGraph !== undefined &&
    ctx.beliefDepGraph.unverified_edge_ratio > UNVERIFIED_EDGE_RATIO_THRESHOLD &&
    ctx.planToolWorkflow !== undefined
  ) {
    ctx.planToolWorkflow()
  }

  let output: unknown = null
  let error: string | null = null
  let success = false
  let status: ExecutionStatus = 'failed'

  const recordFailure = (message: string): void => {
    const symptom = classifySystemErrorSymptom(message)

    // Tool error → Evidence(HIGH, SYSTEM_ERROR) in evidence store
    ctx.evidenceStore.observations.push({
      id: `sys-err-${makeRollbackRef()}`,
      obs: symptom ? `${symptom} — Tool execution failed: ${message}` : `Tool execution failed: ${message}`,
      reliability: 'HIGH',
      source: 'execution_engine',
      evidence_type: 'SYSTEM_ERROR',
      freshness: new Date().toISOString(),
    })

    // Update world model observations
    ctx.worldModel.observations.push({
      id: `err-obs-${makeRollbackRef()}`,
      content: `SYSTEM_ERROR: ${message}`,
      source: 'execution_engine',
      recorded_at: new Date().toISOString(),
    })

    // Transition task to FAILED
    try {
      applyTaskOutcome(ctx.taskGraph, taskId, { status: 'FAILED', fromExecutionLayer: true })
    } catch {
      // task may already be in another state
    }
  }

  try {
    const raw = await toolFn({
      worldModel: ctx.worldModel,
      evidenceStore: ctx.evidenceStore,
      controlState: ctx.controlState,
      diagnostics: ctx.diagnostics,
      failureDiagnostics: ctx.failureDiagnostics,
    })
    if (isContinuableOutcome(raw)) {
      status = raw.__harnessExecutionStatus
      output = raw.output ?? null
      success = status !== 'failed'
      if (status === 'failed') {
        error = raw.error ?? 'execution reported a failed status'
        recordFailure(error)
      }
    } else {
      output = raw
      success = true
      status = 'complete'
    }
  } catch (err) {
    if (isHarnessPauseSignal(err)) {
      // environment_change_log always recorded, regardless of outcome — including this
      // rethrow, which otherwise skipped the push below entirely and left a silent gap
      // for any attempt that ended in a pause rather than a normal complete/fail.
      ctx.worldModel.environment_change_log.push({
        id: `change-${makeRollbackRef()}`,
        description: proposedChange.description ?? 'execution',
        affected_paths: [],
        timestamp: new Date().toISOString(),
      })
      throw err
    }
    error = err instanceof Error ? err.message : String(err)
    status = 'failed'
    recordFailure(error)
  }

  // environment_change_log always recorded, regardless of outcome
  ctx.worldModel.environment_change_log.push({
    id: `change-${makeRollbackRef()}`,
    description: proposedChange.description ?? 'execution',
    affected_paths: [],
    timestamp: new Date().toISOString(),
  })

  return { success, output, error, strategy, rollback_ref, status }
}
