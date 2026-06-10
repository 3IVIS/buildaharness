import { type StrategyType, DEFAULT_STRATEGY_ORDER, StrategyState } from '../state/strategy-state.js'
import type { StrategyWeightKey, ExperienceStore } from '../state/experience-store.js'
import type { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { TaskGraph } from '../state/task-graph.js'
import type { Task } from '../state/task-graph.js'
import type { WorldModel } from '../state/world-model.js'
import type { CallerState } from '../state/caller-state.js'

export type ReplanScope = 'LOCAL' | 'GLOBAL'

export interface RollbackReplanResult {
  rolledBack: boolean
  cannotProgress: boolean
  newStrategyState: StrategyState
  newTaskGraph: TaskGraph
  replanScope: ReplanScope | null
}

export const STALL_WINDOW = 5
export const MAX_SWITCHES = 3
export const RECURRENCE_THRESHOLD = 3
export const OSCILLATION_WINDOW = 6

const CAUTIOUS_THRESHOLD = 1  // index in NORMAL(0) < CAUTIOUS(1) < BLOCKED(2)
const RISK_ORDER: Record<string, number> = { NORMAL: 0, CAUTIOUS: 1, BLOCKED: 2 }

function stalledCompletion(strategyState: StrategyState): boolean {
  const history = strategyState.completion_history
  if (history.length < STALL_WINDOW) return false
  const window = history.slice(-STALL_WINDOW)
  return new Set(window).size === 1
}

function strategyLooping(strategyState: StrategyState): boolean {
  if (strategyState.switch_count <= MAX_SWITCHES) return false
  const history = strategyState.completion_history
  if (history.length === 0) return true
  return history[history.length - 1] === history[0]
}

function failureRecurring(failureDiagnostics: FailureDiagnostics): boolean {
  const history = failureDiagnostics.failure_history
  if (history.length < RECURRENCE_THRESHOLD) return false
  const recent = history.slice(-RECURRENCE_THRESHOLD)
  const classes = recent.map(e => e.failure_class)
  return new Set(classes).size === 1 && classes[0] !== undefined && classes[0] !== ''
}

function riskOscillating(strategyState: StrategyState): boolean {
  const history = strategyState.risk_state_history
  if (history.length < OSCILLATION_WINDOW) return false
  const window = history.slice(-OSCILLATION_WINDOW)
  const levels = window.map(r => RISK_ORDER[r] ?? 0)
  let alternations = 0
  for (let i = 1; i < levels.length; i++) {
    const prevBelowCaution = levels[i - 1] < CAUTIOUS_THRESHOLD
    const curBelowCaution = levels[i] < CAUTIOUS_THRESHOLD
    if (prevBelowCaution !== curBelowCaution) alternations++
  }
  return alternations >= 2
}

export function cannotMakeProgress(
  strategyState: StrategyState,
  failureDiagnostics: FailureDiagnostics,
): boolean {
  if (stalledCompletion(strategyState)) {
    strategyState.stall_reason = 'completion_velocity'
    return true
  }
  if (strategyLooping(strategyState)) {
    strategyState.stall_reason = 'strategy_loop'
    return true
  }
  if (failureRecurring(failureDiagnostics)) {
    strategyState.stall_reason = 'failure_recurrence'
    return true
  }
  if (riskOscillating(strategyState)) {
    strategyState.stall_reason = 'risk_oscillation'
    return true
  }
  strategyState.stall_reason = null
  return false
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values)
  const exps = values.map(v => Math.exp(v - max))
  const total = exps.reduce((a, b) => a + b, 0)
  return exps.map(e => e / total)
}

export function buildStrategyOrdering(
  failureClass: string,
  experienceStore: ExperienceStore,
  _currentStrategy?: StrategyType,
): StrategyType[] {
  if (!experienceStore.available) return [...DEFAULT_STRATEGY_ORDER]

  const weights = experienceStore.getStrategyWeights()
  const classWeights: number[] = DEFAULT_STRATEGY_ORDER.map(s => {
    const key: StrategyWeightKey = `${s}:${failureClass}`
    return weights[key] ?? 0
  })

  if (classWeights.every(v => v === 0)) return [...DEFAULT_STRATEGY_ORDER]

  const probs = softmax(classWeights)
  const indexed = DEFAULT_STRATEGY_ORDER.map((s, i) => ({ s, p: probs[i] }))
  indexed.sort((a, b) => b.p - a.p)
  return indexed.map(x => x.s)
}

function getNextStrategy(current: StrategyType, ordering: StrategyType[]): StrategyType {
  const idx = ordering.indexOf(current)
  const nextIdx = Math.min(idx + 1, ordering.length - 1)
  return ordering[nextIdx]
}

function diagnoseAndReplan(currentTask: Task, taskGraph: TaskGraph): TaskGraph {
  const currentId = currentTask.id
  for (const task of taskGraph.tasks) {
    if (task.depends_on.includes(currentId) && task.status !== 'COMPLETE') {
      task.status = 'PENDING'
    }
  }
  taskGraph.tasks = taskGraph.tasks.filter(
    t => !(t.status === 'FAILED' && t.depends_on.includes(currentId)),
  )
  taskGraph.changed = true
  return taskGraph
}

function validateTaskGraph(taskGraph: TaskGraph): string[] {
  const errors: string[] = []
  const ids = new Set(taskGraph.tasks.map(t => t.id))
  for (const task of taskGraph.tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) errors.push(`Task "${task.id}" depends on unknown task "${dep}"`)
    }
  }
  return errors
}

function rebuildTaskGraph(worldModel: WorldModel, callerState: CallerState): TaskGraph {
  const successCriteria = callerState.success_criteria ?? []
  const newTasks = successCriteria.map((criterion: string, i: number) => ({
    id: `rebuilt-task-${i}-${Math.random().toString(36).slice(2, 6)}`,
    description: String(criterion),
    status: 'PENDING' as const,
    risk_level: 'MEDIUM' as const,
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 1,
    assigned_strategy: null,
  }))

  const beliefTasks = worldModel.beliefs.slice(0, 5).map((belief, i) => ({
    id: `belief-verify-${i}-${Math.random().toString(36).slice(2, 6)}`,
    description: `Verify: ${belief.content.slice(0, 120)}`,
    status: 'PENDING' as const,
    risk_level: 'LOW' as const,
    depends_on: [],
    parallel_write_domains: [],
    abstraction_level: 2,
    assigned_strategy: null,
  }))

  return new TaskGraph({ tasks: [...newTasks, ...beliefTasks], changed: true })
}

export function rollbackAndReplan(
  currentTask: Task,
  strategyState: StrategyState,
  failureDiagnostics: FailureDiagnostics,
  taskGraph: TaskGraph,
  worldModel: WorldModel,
  callerState: CallerState,
  experienceStore: ExperienceStore | null,
  rollbackFn?: () => void,
): RollbackReplanResult {
  // Rollback
  rollbackFn?.()

  // Record failure
  failureDiagnostics.failure_history.push({
    id: `fail-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    failure_class: failureDiagnostics.matched_pattern?.failure_class ?? 'unknown',
    description: `Task failed: ${currentTask.description}`,
    context: { task_id: currentTask.id },
  })

  const noProgress = cannotMakeProgress(strategyState, failureDiagnostics)
  const failureClass = failureDiagnostics.matched_pattern?.failure_class ?? ''

  // Determine next strategy
  let ordering: StrategyType[]
  if (experienceStore !== null && experienceStore.available) {
    ordering = buildStrategyOrdering(failureClass, experienceStore, strategyState.current_strategy)
  } else {
    ordering = [...DEFAULT_STRATEGY_ORDER]
  }

  const nextStrategy = getNextStrategy(strategyState.current_strategy, ordering)
  const newStrategyState = new StrategyState({
    ...strategyState.toJSON(),
    current_strategy: nextStrategy,
    switch_count: strategyState.switch_count + 1,
    switch_triggers: [...strategyState.switch_triggers, `task_failed: ${currentTask.id}`],
    stall_reason: strategyState.stall_reason,
    completion_history: [...strategyState.completion_history],
    risk_state_history: [...strategyState.risk_state_history],
  })

  // Determine replan scope and replan
  let newTaskGraph: TaskGraph
  let replanScope: ReplanScope | null = null

  if (noProgress) {
    replanScope = 'GLOBAL'
    newTaskGraph = rebuildTaskGraph(worldModel, callerState)
    const errors = validateTaskGraph(newTaskGraph)
    if (errors.length > 0) {
      throw new Error(`Rebuilt task graph is invalid: ${errors.join('; ')}`)
    }
  } else {
    replanScope = 'LOCAL'
    newTaskGraph = diagnoseAndReplan(currentTask, taskGraph)
  }

  return {
    rolledBack: true,
    cannotProgress: noProgress,
    newStrategyState,
    newTaskGraph,
    replanScope,
  }
}
