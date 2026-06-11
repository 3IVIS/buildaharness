import { ProcessConceptNotFoundError } from './process-concept.js'
import type { ProcessRegistry } from './process-registry.js'
import type { TaskGraph } from './state/task-graph.js'

export interface ProcessSummary {
  id: string
  name: string
  description: string
  stepCount: number
}

export interface LoadProcessResult {
  conceptId: string
  seededSteps: number
  firstStep: CurrentStepResult | null
}

export interface CurrentStepResult {
  id: string
  description: string
  riskLevel: string
  expectedTools: string[]
  successCriteria: string[]
}

export interface CompleteStepResult {
  completed: string
  nextStep: CurrentStepResult | null
}

export function listProcesses(registry: ProcessRegistry): ProcessSummary[] {
  return registry.listAvailable().map(conceptId => {
    const concept = registry.load(conceptId)
    return {
      id: concept.id,
      name: concept.name,
      description: concept.description,
      stepCount: concept.steps.length,
    }
  })
}

export function loadProcess(
  conceptId: string,
  taskGraph: TaskGraph,
  registry: ProcessRegistry,
): LoadProcessResult {
  const concept = registry.load(conceptId)

  const namespacePrefix = `${conceptId}:`
  const alreadySeeded = taskGraph.tasks.some(t => t.id.startsWith(namespacePrefix))

  if (!alreadySeeded) {
    concept.seedTaskGraph(taskGraph)
  }

  return {
    conceptId,
    seededSteps: concept.steps.length,
    firstStep: getCurrentStep(taskGraph),
  }
}

export function getCurrentStep(taskGraph: TaskGraph): CurrentStepResult | null {
  const task = taskGraph.selectUnblockedLeaf()
  if (task === null) return null
  return {
    id: task.id,
    description: task.description,
    riskLevel: task.risk_level,
    expectedTools: [],
    successCriteria: [],
  }
}

export function completeStep(stepId: string, taskGraph: TaskGraph): CompleteStepResult {
  const task = taskGraph.tasks.find(t => t.id === stepId)
  if (!task) {
    throw new ProcessConceptNotFoundError(stepId)
  }
  if (task.status === 'COMPLETE') {
    throw new Error(`step_id "${stepId}" is already COMPLETE`)
  }
  task.status = 'COMPLETE'
  taskGraph.changed = true
  return {
    completed: stepId,
    nextStep: getCurrentStep(taskGraph),
  }
}
