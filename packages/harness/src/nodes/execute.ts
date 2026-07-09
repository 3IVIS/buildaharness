import type { WorldModel } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { TaskGraph, Task } from '../state/task-graph.js'
import type { MemoryState } from '../state/memory-state.js'
import type { BeliefDepGraph } from '../state/world-model.js'

export type ReversibilityStrategy = 'snapshot' | 'git-revert' | 'patch-rollback' | 'ephemeral'

export interface ExecutionResult {
  success: boolean
  output: unknown
  error: string | null
  strategy: ReversibilityStrategy
  rollback_ref: string | null
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
function classifySystemErrorSymptom(message: string): string | null {
  const lower = message.toLowerCase()
  for (const { test, symptom } of SYSTEM_ERROR_SYMPTOM_PATTERNS) {
    if (test(lower)) return symptom
  }
  return null
}

export function execute(
  proposedChange: ProposedExecutionChange,
  toolFn: (() => unknown),
  ctx: ExecutionContext,
): ExecutionResult {
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

  try {
    output = toolFn()
    success = true
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    const symptom = classifySystemErrorSymptom(error)

    // Tool error → Evidence(HIGH, SYSTEM_ERROR) in evidence store
    ctx.evidenceStore.observations.push({
      id: `sys-err-${makeRollbackRef()}`,
      obs: symptom ? `${symptom} — Tool execution failed: ${error}` : `Tool execution failed: ${error}`,
      reliability: 'HIGH',
      source: 'execution_engine',
      evidence_type: 'SYSTEM_ERROR',
      freshness: new Date().toISOString(),
    })

    // Update world model observations
    ctx.worldModel.observations.push({
      id: `err-obs-${makeRollbackRef()}`,
      content: `SYSTEM_ERROR: ${error}`,
      source: 'execution_engine',
      recorded_at: new Date().toISOString(),
    })

    // Transition task to FAILED
    try {
      ctx.taskGraph.setStatus(taskId, 'FAILED', { fromExecutionLayer: true })
    } catch {
      // task may already be in another state
    }
  }

  // environment_change_log always recorded, regardless of outcome
  ctx.worldModel.environment_change_log.push({
    id: `change-${makeRollbackRef()}`,
    description: proposedChange.description ?? 'execution',
    affected_paths: [],
    timestamp: new Date().toISOString(),
  })

  return { success, output, error, strategy, rollback_ref }
}
