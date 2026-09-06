// Trajectory digest — bounded, human-readable input to the supervisor
// (S0 of plans/harness_trajectory_supervisor_plan.html). TS twin of
// adapter/harness/trajectory_digest.py.
//
// buildDigest() is a deterministic assembly step — no LLM call. It follows the same
// contract as escalate()'s SurfaceBlocker: the output carries NO raw world-model
// JSON, no hypothesis-set / evidence-store entries, and every list field is
// length-capped. Only scalar / short-string projections of the run state are pulled
// through.

import { DEFAULT_STRATEGY_ORDER, type StrategyState } from './state/strategy-state.js'
import type { FailureDiagnostics } from './state/failure-diagnostics.js'
import type { TaskGraph } from './state/task-graph.js'
import type { WorldModel } from './state/world-model.js'

const MAX_GOAL = 12
const MAX_LIST = 10
const MAX_STR = 240

function clip(text: unknown, limit = MAX_STR): string {
  const s = String(text ?? '').trim()
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…'
}

function cap<T>(items: T[], limit = MAX_LIST): T[] {
  return items.slice(0, limit)
}

export interface StrategyTried {
  strategy: string
  outcome: string
}
export interface FailureClassCount {
  class: string
  count: number
}

export interface TrajectoryDigestData {
  goal: string[]
  steps_taken: number
  stall_reason: string
  stall_history: string[]
  strategies_tried: StrategyTried[]
  failure_classes: FailureClassCount[]
  reopened_tasks: string[]
  open_contradictions: string[]
  blocking_unknowns: string[]
  budget_remaining: Record<string, unknown>
}

export class TrajectoryDigest {
  goal: string[]
  steps_taken: number
  stall_reason: string
  stall_history: string[]
  strategies_tried: StrategyTried[]
  failure_classes: FailureClassCount[]
  reopened_tasks: string[]
  open_contradictions: string[]
  blocking_unknowns: string[]
  budget_remaining: Record<string, unknown>

  constructor(data?: Partial<TrajectoryDigestData>) {
    this.goal = data?.goal ?? []
    this.steps_taken = data?.steps_taken ?? 0
    this.stall_reason = data?.stall_reason ?? ''
    this.stall_history = data?.stall_history ?? []
    this.strategies_tried = data?.strategies_tried ?? []
    this.failure_classes = data?.failure_classes ?? []
    this.reopened_tasks = data?.reopened_tasks ?? []
    this.open_contradictions = data?.open_contradictions ?? []
    this.blocking_unknowns = data?.blocking_unknowns ?? []
    this.budget_remaining = data?.budget_remaining ?? {}
  }

  toJSON(): TrajectoryDigestData {
    return {
      goal: [...this.goal],
      steps_taken: this.steps_taken,
      stall_reason: this.stall_reason,
      stall_history: [...this.stall_history],
      strategies_tried: this.strategies_tried.map(s => ({ ...s })),
      failure_classes: this.failure_classes.map(f => ({ ...f })),
      reopened_tasks: [...this.reopened_tasks],
      open_contradictions: [...this.open_contradictions],
      blocking_unknowns: [...this.blocking_unknowns],
      budget_remaining: { ...this.budget_remaining },
    }
  }

  static fromJSON(json: unknown): TrajectoryDigest {
    const d = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
    let steps = Number(d.steps_taken ?? 0)
    if (!Number.isFinite(steps)) steps = 0
    const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
    return new TrajectoryDigest({
      goal: cap(asArr(d.goal).map(g => clip(g)), MAX_GOAL),
      steps_taken: Math.max(0, Math.trunc(steps)),
      stall_reason: clip(d.stall_reason ?? ''),
      stall_history: cap(asArr(d.stall_history).map(s => clip(s, 80))),
      strategies_tried: cap(
        asArr(d.strategies_tried)
          .filter(s => s && typeof s === 'object')
          .map(s => {
            const o = s as Record<string, unknown>
            return { strategy: clip(o.strategy ?? '', 40), outcome: clip(o.outcome ?? '', 80) }
          }),
      ),
      failure_classes: cap(
        asArr(d.failure_classes)
          .filter(f => f && typeof f === 'object')
          .map(f => {
            const o = f as Record<string, unknown>
            let n = Number(o.count ?? 0)
            if (!Number.isFinite(n)) n = 0
            return { class: clip(o.class ?? '', 80), count: Math.trunc(n) }
          }),
      ),
      reopened_tasks: cap(asArr(d.reopened_tasks).map(t => clip(t))),
      open_contradictions: cap(asArr(d.open_contradictions).map(c => clip(c))),
      blocking_unknowns: cap(asArr(d.blocking_unknowns).map(u => clip(u))),
      budget_remaining: (d.budget_remaining && typeof d.budget_remaining === 'object'
        ? { ...(d.budget_remaining as Record<string, unknown>) }
        : {}),
    })
  }
}

function strategiesTried(ss: StrategyState): StrategyTried[] {
  const switchCount = Math.max(0, Math.trunc(ss.switch_count ?? 0))
  const triggers = ss.switch_triggers ?? []
  const out: StrategyTried[] = []
  const n = Math.min(switchCount, DEFAULT_STRATEGY_ORDER.length)
  for (let i = 0; i < n; i++) {
    out.push({
      strategy: DEFAULT_STRATEGY_ORDER[i],
      outcome: i < triggers.length ? clip(triggers[i], 80) : 'switched',
    })
  }
  const current = ss.current_strategy ?? ''
  if (current && (out.length === 0 || out[out.length - 1].strategy !== current)) {
    out.push({ strategy: clip(current, 40), outcome: 'current' })
  }
  return cap(out)
}

function failureClasses(fd: FailureDiagnostics | null | undefined): FailureClassCount[] {
  const history = fd?.failure_history ?? []
  const counts = new Map<string, number>()
  for (const entry of history) {
    const fc = (entry as { failure_class?: string })?.failure_class
    if (fc) counts.set(fc, (counts.get(fc) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LIST)
    .map(([fc, n]) => ({ class: clip(fc, 80), count: n }))
}

function openContradictions(wm: WorldModel): string[] {
  const out: string[] = []
  for (const c of wm.contradictions ?? []) {
    if (c.severity !== 'HIGH') continue
    const desc = c.description ?? ''
    const cid = c.id ?? '?'
    if (desc) out.push(clip(`${cid}: ${desc}`))
    else out.push(clip(`${cid}: beliefs ${(c.involved_belief_ids ?? []).slice(0, 4).join(', ')}`))
  }
  return cap(out)
}

export interface BuildDigestOptions {
  successCriteria?: string[]
  recoveryBudget?: { toJSON(): Record<string, unknown> } | Record<string, unknown> | null
  reopenedTaskDescriptions?: string[]
  missingInfo?: string[]
}

/** Assemble a bounded TrajectoryDigest from live run state. Deterministic; no LLM. */
export function buildDigest(
  strategyState: StrategyState,
  failureDiagnostics: FailureDiagnostics | null | undefined,
  taskGraph: TaskGraph,
  worldModel: WorldModel,
  opts: BuildDigestOptions = {},
): TrajectoryDigest {
  const completionHistory = strategyState.completion_history ?? []
  const failed = (taskGraph.tasks ?? [])
    .filter(t => t.status === 'FAILED')
    .map(t => clip(t.description || t.id))
  const reopened = [...(opts.reopenedTaskDescriptions ?? []), ...failed].filter(Boolean)

  let budget: Record<string, unknown> = {}
  const rb = opts.recoveryBudget
  if (rb && typeof rb === 'object') {
    budget = typeof (rb as { toJSON?: unknown }).toJSON === 'function'
      ? (rb as { toJSON(): Record<string, unknown> }).toJSON()
      : { ...(rb as Record<string, unknown>) }
  }

  return new TrajectoryDigest({
    goal: cap((opts.successCriteria ?? []).map(c => clip(c)), MAX_GOAL),
    steps_taken: completionHistory.length,
    stall_reason: clip(strategyState.stall_reason ?? ''),
    stall_history: cap((strategyState.switch_triggers ?? []).map(t => clip(t, 80))),
    strategies_tried: strategiesTried(strategyState),
    failure_classes: failureClasses(failureDiagnostics),
    reopened_tasks: cap(reopened),
    open_contradictions: openContradictions(worldModel),
    blocking_unknowns: cap([
      ...(worldModel.assumptions ?? []).filter(a => String(a ?? '').trim()).map(a => clip(a)),
      ...(opts.missingInfo ?? []).map(m => clip(m)),
    ]),
    budget_remaining: budget,
  })
}
