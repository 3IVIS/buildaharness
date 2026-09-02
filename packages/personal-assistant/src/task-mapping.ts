import type { Task } from '@buildaharness/harness'
import { classifyRisk } from './risk-classifier.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'

/**
 * Builds a fresh harness Task[] from a flat task-spec list — shared by the single-task
 * fallback, the ad hoc decomposition path, a newly built plan, and a resumed plan.
 * `status` defaults to 'PENDING' when omitted (decomposeObjective's and
 * buildPlanFromTemplate's output never carries one). A resumed plan passes its tasks'
 * real statuses through *including* COMPLETE ones — TaskGraph.selectUnblockedLeaf
 * resolves depends_on by looking up each dependency's status in the current graph, so
 * a completed dependency that got filtered out of initialTasks would never register as
 * satisfied and its dependents would stay permanently blocked.
 *
 * A task's own `riskLevel` (classifyTurnIntent's per-task judgment for ad hoc decompositions,
 * or buildPlanFromTemplate's template-curated risk_level for a plan — see plan-store.ts's
 * PlanTaskRecord) is used directly when present — see Phase 4.2 of the harness layer activation
 * plan: a plan step like "delete the draft file" shouldn't inherit an unrelated sibling step's
 * risk profile just because they were rendered from the same turn-level classification.
 * `fallbackRiskLevel` (one flat level, or a per-task function keyed off description) is only
 * consulted when a task has no `riskLevel` of its own — the single-task path (never has one,
 * always uses the flat turn-level classification.riskLevel) and a plan persisted before this
 * field existed (falls back to lexical planTaskRiskLevel/classifyRisk, exactly as every task
 * used to unconditionally).
 */
export function toHarnessTasks(
  tasks: { id: string; description: string; depends_on: string[]; status?: Task['status']; riskLevel?: Task['risk_level'] }[],
  fallbackRiskLevel: Task['risk_level'] | ((description: string) => Task['risk_level']),
): Task[] {
  return tasks.map((t): Task => ({
    id: t.id,
    description: t.description,
    status: t.status ?? 'PENDING',
    risk_level: t.riskLevel ?? (typeof fallbackRiskLevel === 'function' ? fallbackRiskLevel(t.description) : fallbackRiskLevel),
    depends_on: t.depends_on,
    parallel_write_domains: [],
    abstraction_level: 0,
    assigned_strategy: null,
  }))
}

/**
 * packages/harness's own risk-level types (Task['risk_level'], TurnComplexitySignal['riskLevel'])
 * are a strict LOW/MEDIUM/HIGH enum with no UNKNOWN concept — classification.riskLevel can be
 * 'UNKNOWN' only via failSafeClassification (turn-intent-classifier.ts), which also always leaves
 * decomposedTasks null, so in practice this only ever maps the flat, single-task fallback path.
 * Mapped to 'HIGH' (not 'LOW') as the conservative choice: an unknown risk should get the
 * harness's most cautious handling, not its least. Shared by every module that crosses into a
 * packages/harness-typed field (task-interpreter.ts and harness-bridge.ts).
 */
export function toTaskRiskLevel(riskLevel: TurnIntentClassification['riskLevel']): Task['risk_level'] {
  return riskLevel === 'UNKNOWN' ? 'HIGH' : riskLevel
}

/** Lexical fallback for a durable plan's steps that were persisted before per-task riskLevel existed (see toHarnessTasks) — reuses classifyRisk's own keyword patterns against each step's own description. */
export function planTaskRiskLevel(description: string): Task['risk_level'] {
  return classifyRisk(description).riskLevel
}
