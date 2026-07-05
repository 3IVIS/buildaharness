import type { WorldModel, BeliefDepGraph, DepGraphBudget, EnvironmentChange } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { TaskGraph } from '../state/task-graph.js'
import type { Diagnostics } from '../state/diagnostics.js'
import type { ControlState } from '../state/control-state.js'
import type { CallerState } from '../state/caller-state.js'
import { MemoryState, type Structure, type PrunedRegion, type JournalEntry } from '../state/memory-state.js'

const COMPRESSION_THRESHOLD = 0.9

export interface CompressionResult {
  dropped: Structure[]
  pruned: PrunedRegion[]
}

function assessContextPressure(memoryState: MemoryState): number {
  const { total, used } = memoryState.token_budget
  if (total === 0) return 1
  return used / total
}

function compressMemory(
  memoryState: MemoryState,
  _preserveSet: string[],
): CompressionResult {
  const dropped: Structure[] = []
  const pruned: PrunedRegion[] = []
  const now = new Date().toISOString()

  // Drop oldest compressed_structures if above budget
  const excess = memoryState.compression_risk.compressed_structures.length - 10
  if (excess > 0) {
    const toDrop = memoryState.compression_risk.compressed_structures.splice(0, excess)
    dropped.push(...toDrop)
  }

  // Prune regions that are no longer in the preserve set
  const regionsToPrune = memoryState.compression_risk.pruned_regions.filter(
    r => !_preserveSet.includes(r.id),
  )
  if (regionsToPrune.length > 0) {
    pruned.push(...regionsToPrune.map(r => ({ ...r, pruned_at: now })))
  }

  return { dropped, pruned }
}

// Matches adapter/harness/staleness.py's _DEFAULT_BELIEF_TTL (30 minutes).
const BELIEF_TTL_MS = 30 * 60 * 1000

function stalenessSweep(worldModel: WorldModel, environmentChangeLog: EnvironmentChange[]): void {
  const now = Date.now()
  const staleFlags = worldModel.stale_flags

  for (const belief of worldModel.beliefs) {
    if (staleFlags[belief.id]) continue

    const beliefTs = new Date(belief.recorded_at).getTime()

    // TTL-based invalidation
    if (now - beliefTs > BELIEF_TTL_MS) {
      staleFlags[belief.id] = true
      continue
    }

    // Environment-change-based invalidation: a belief is stale once a change
    // affecting one of its derivation sources is logged after it was recorded.
    const beliefSources = new Set([...belief.derived_from, ...(belief.supporting_evidence ?? [])])
    for (const change of environmentChangeLog) {
      if (!change.affected_paths.some(p => beliefSources.has(p))) continue
      const changeTs = new Date(change.timestamp).getTime()
      if (Number.isNaN(changeTs)) continue
      if (changeTs > beliefTs) {
        staleFlags[belief.id] = true
        break
      }
    }
  }
}

function applyJournalRetentionPolicy(memoryState: MemoryState): void {
  const policy = memoryState.journal_retention_policy
  const journal = memoryState.journal

  const failures: JournalEntry[] = []
  const passingVerbatim: JournalEntry[] = []

  for (const entry of journal) {
    if (!entry.success && policy.retain_failures_permanently) {
      failures.push(entry)
    } else if (entry.success) {
      passingVerbatim.push(entry)
    }
  }

  // Keep only last N passing verbatim; compress older passing to summary records
  const recentPassing = passingVerbatim.slice(-policy.max_passing_verbatim)
  const compressedOlder: JournalEntry[] = []
  if (policy.compress_older_passing && passingVerbatim.length > policy.max_passing_verbatim) {
    const olderPassing = passingVerbatim.slice(0, -policy.max_passing_verbatim)
    for (const entry of olderPassing) {
      compressedOlder.push({
        step: entry.step,
        action_class: entry.action_class,
        outcome: entry.outcome,
        success: entry.success,
        // verbatim dropped — compressed to summary record
      })
    }
  }

  memoryState.journal = [...failures, ...compressedOlder, ...recentPassing]
}

export function contextCompression(
  memoryState: MemoryState,
  worldModel: WorldModel,
  beliefDepGraph: BeliefDepGraph,
  depGraphBudget: DepGraphBudget,
  hypothesisSet: HypothesisSet,
  taskGraph: TaskGraph,
  diagnostics: Diagnostics,
  controlState: ControlState,
  callerState: CallerState,
): void {
  const pressure = assessContextPressure(memoryState)

  // Trigger compression at 90% of token_budget — leaves headroom for the pass itself
  if (pressure >= COMPRESSION_THRESHOLD) {
    const preserveSet = [
      'worldModel',
      'beliefDepGraph',
      'hypothesisSet',
      'taskGraph',
      'diagnostics',
      'controlState',
      'callerState',
    ]
    const result = compressMemory(memoryState, preserveSet)

    // Track compression risk separately
    memoryState.compression_risk.compressed_structures.push(...result.dropped)
    memoryState.compression_risk.pruned_regions.push(...result.pruned)
  }

  // Staleness sweep: TTL + environment-change invalidation
  stalenessSweep(worldModel, worldModel.environment_change_log)

  // dep_graph decay: independently of content changes
  depGraphBudget.applyDecay(beliefDepGraph)

  // Journal retention policy: retain failures + last N passing verbatim; compress older
  applyJournalRetentionPolicy(memoryState)

  // Suppress unused-var warnings — all params needed for API surface consistency
  void hypothesisSet
  void taskGraph
  void diagnostics
  void controlState
  void callerState
}
