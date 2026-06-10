import { WorldModel, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js'
import { CallerState } from '../state/caller-state.js'
import { ControlState } from '../state/control-state.js'
import { TaskGraph, type Task } from '../state/task-graph.js'
import { Diagnostics } from '../state/diagnostics.js'
import { HypothesisSet } from '../state/hypothesis-set.js'
import { EvidenceStore, type ToolAvailability } from '../state/evidence-store.js'
import { MemoryState } from '../state/memory-state.js'
import { StrategyState } from '../state/strategy-state.js'
import { FailureDiagnostics } from '../state/failure-diagnostics.js'
import { OutputContract } from '../state/output-contract.js'
import { resolveControlState, RECOVERY_ACTION_DEPENDENCIES } from './resolve-control-state.js'
import { normalise, DimensionType } from '../normalise.js'

export class SelfReferentialDependencyError extends Error {
  constructor(actionClass: string) {
    super(`Self-referential recovery action dependency detected for "${actionClass}"`)
    this.name = 'SelfReferentialDependencyError'
  }
}

export class InvalidTaskGraphError extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(`Task graph validation failed: ${errors.join('; ')}`)
    this.name = 'InvalidTaskGraphError'
    this.errors = errors
  }
}

export function validateRecoveryActionDependencies(
  deps: Record<string, string[]> = RECOVERY_ACTION_DEPENDENCIES,
): void {
  for (const [action, required] of Object.entries(deps)) {
    if (required.includes(action)) {
      throw new SelfReferentialDependencyError(action)
    }
  }
}

export function validateTaskGraph(taskGraph: TaskGraph): string[] {
  const errors: string[] = []
  const ids = new Set(taskGraph.tasks.map(t => t.id))
  for (const task of taskGraph.tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`)
      }
    }
  }
  return errors
}

function checkAbstractionAlignment(taskGraph: TaskGraph): number {
  if (taskGraph.tasks.length === 0) return 1.0
  const maxLevel = 2
  const mean = taskGraph.tasks.reduce((acc, t) => acc + t.abstraction_level, 0) / taskGraph.tasks.length
  return normalise(1 - mean / (maxLevel + 1), DimensionType.ratio)
}

export interface ToolConfig {
  available: boolean
  fallback_tool?: string | null
}

export interface HarnessInitOptions {
  max_steps?: number
  toolConfigs?: Record<string, ToolConfig>
  initialTasks?: Task[]
  successCriteria?: string[]
  callerConstraints?: Record<string, unknown>
  outputContract?: Partial<{
    format: string
    required_sections: string[]
    interface_constraints: Record<string, unknown>
    validation_rules: string[]
    caller_specific_constraints: Record<string, unknown>
  }>
  processConceptId?: string
  recoveryActionDeps?: Record<string, string[]>
}

export interface HarnessInitResult {
  worldModel: WorldModel
  callerState: CallerState
  controlState: ControlState
  taskGraph: TaskGraph
  diagnostics: Diagnostics
  hypothesisSet: HypothesisSet
  evidenceStore: EvidenceStore
  memoryState: MemoryState
  strategyState: StrategyState
  failureDiagnostics: FailureDiagnostics
  outputContract: OutputContract
  beliefDepGraph: BeliefDepGraph
  depGraphBudget: DepGraphBudget
  maxSteps: number
  decompositionGate: boolean
  valid: boolean
  errors: string[]
  processConceptId: string | null
}

export function initializeHarness(
  _objective: string,
  options: HarnessInitOptions = {},
): HarnessInitResult {
  const {
    max_steps = 50,
    toolConfigs = {},
    initialTasks = [],
    successCriteria = [],
    callerConstraints = {},
    outputContract: outputContractOptions,
    processConceptId,
    recoveryActionDeps = RECOVERY_ACTION_DEPENDENCIES,
  } = options

  // Validate recovery action dependencies — throws immediately on self-referential dep
  validateRecoveryActionDependencies(recoveryActionDeps)

  // Create all 13 state objects
  const worldModel = new WorldModel()

  const callerState = new CallerState({
    success_criteria: successCriteria,
    current_constraints: callerConstraints,
  })

  const taskGraph = new TaskGraph({
    tasks: initialTasks.length > 0
      ? initialTasks.map(t => ({ ...t }))
      : successCriteria.map((criterion, i) => ({
          id: `task-${i}`,
          description: String(criterion),
          status: 'PENDING' as const,
          risk_level: 'MEDIUM' as const,
          depends_on: [],
          parallel_write_domains: [],
          abstraction_level: 1,
          assigned_strategy: null,
        })),
  })

  const diagnostics = new Diagnostics()
  const hypothesisSet = new HypothesisSet()

  // Populate tool_availability_manifest
  const toolManifest: Record<string, ToolAvailability> = {}
  for (const [toolName, config] of Object.entries(toolConfigs)) {
    toolManifest[toolName] = {
      available: config.available,
      fallback_tool: config.fallback_tool ?? null,
    }
  }

  const evidenceStore = new EvidenceStore({
    tool_availability_manifest: toolManifest,
  })

  const memoryState = new MemoryState({
    journal_retention_policy: {
      retain_failures_permanently: true,
      max_passing_verbatim: 20,
      compress_older_passing: true,
    },
  })

  const strategyState = new StrategyState()
  const failureDiagnostics = new FailureDiagnostics()

  const outputContract = new OutputContract(outputContractOptions ?? {})

  const beliefDepGraph = new BeliefDepGraph()
  const depGraphBudget = new DepGraphBudget()

  // Validate task graph
  const graphErrors = validateTaskGraph(taskGraph)
  if (graphErrors.length > 0) {
    return {
      worldModel,
      callerState,
      controlState: new ControlState(),
      taskGraph,
      diagnostics,
      hypothesisSet,
      evidenceStore,
      memoryState,
      strategyState,
      failureDiagnostics,
      outputContract,
      beliefDepGraph,
      depGraphBudget,
      maxSteps: max_steps,
      decompositionGate: false,
      valid: false,
      errors: graphErrors,
      processConceptId: processConceptId ?? null,
    }
  }

  // Initial diagnostics setup
  diagnostics.verification_health.feasibility = checkAbstractionAlignment(taskGraph)
  diagnostics.coverage_health.symptom_coverage = normalise(0.5, DimensionType.ratio)
  diagnostics.coverage_health.explanation_coverage = normalise(0.5, DimensionType.ratio)

  // generation_id++ → resolve_control_state → decomposition_gate
  worldModel.incrementGenerationId()
  const controlState = resolveControlState(diagnostics, worldModel, failureDiagnostics)
  const decompositionGate = controlState.risk_state !== 'BLOCKED'

  return {
    worldModel,
    callerState,
    controlState,
    taskGraph,
    diagnostics,
    hypothesisSet,
    evidenceStore,
    memoryState,
    strategyState,
    failureDiagnostics,
    outputContract,
    beliefDepGraph,
    depGraphBudget,
    maxSteps: max_steps,
    decompositionGate,
    valid: true,
    errors: [],
    processConceptId: processConceptId ?? null,
  }
}
