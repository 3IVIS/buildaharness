import { type Task, type TaskGraph } from './state/task-graph.js'

export class ProcessConceptValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProcessConceptValidationError'
  }
}

export class ProcessConceptNotFoundError extends Error {
  constructor(conceptId: string) {
    super(`Process concept "${conceptId}" not found in registry`)
    this.name = 'ProcessConceptNotFoundError'
  }
}

export type RiskLevelStr = 'LOW' | 'MEDIUM' | 'HIGH'
export type AbstractionLevelStr = 'module' | 'goal' | 'subgoal' | 'function' | 'leaf' | 'statement'

export interface ProcessConceptStep {
  id: string
  description: string
  dependsOn: string[]
  riskLevel: RiskLevelStr
  abstractionLevel: AbstractionLevelStr
  expectedTools: string[]
  successCriteria: string[]
  strategyHint: string | null
}

const ABSTRACTION_MAP: Record<AbstractionLevelStr, number> = {
  module: 0,
  goal: 0,
  subgoal: 1,
  function: 1,
  leaf: 2,
  statement: 2,
}

const VALID_RISK_LEVELS = new Set<RiskLevelStr>(['LOW', 'MEDIUM', 'HIGH'])
const VALID_ABSTRACTION_LEVELS = new Set<AbstractionLevelStr>([
  'module', 'goal', 'subgoal', 'function', 'leaf', 'statement',
])

export class ProcessConcept {
  id: string
  name: string
  description: string
  successCriteria: string[]
  schemaVersion: string
  steps: ProcessConceptStep[]

  constructor(data: {
    id: string
    name: string
    description: string
    successCriteria: string[]
    schemaVersion: string
    steps: ProcessConceptStep[]
  }) {
    this.id = data.id
    this.name = data.name
    this.description = data.description
    this.successCriteria = data.successCriteria
    this.schemaVersion = data.schemaVersion
    this.steps = data.steps
  }

  validate(): string[] {
    const errors: string[] = []

    if (!this.id || !this.id.trim()) {
      errors.push("Concept 'id' must be a non-empty string")
    }

    const stepIds: string[] = []
    const seen = new Set<string>()

    for (const step of this.steps) {
      if (!step.id || !step.id.trim()) {
        errors.push('Each step must have a non-empty id')
        continue
      }
      if (seen.has(step.id)) {
        errors.push(`Duplicate step id "${step.id}"`)
      } else {
        seen.add(step.id)
        stepIds.push(step.id)
      }

      if (!VALID_RISK_LEVELS.has(step.riskLevel)) {
        errors.push(`Step "${step.id}": riskLevel "${step.riskLevel}" must be one of HIGH, LOW, MEDIUM`)
      }
      if (!VALID_ABSTRACTION_LEVELS.has(step.abstractionLevel)) {
        errors.push(
          `Step "${step.id}": abstractionLevel "${step.abstractionLevel}" must be one of function, goal, leaf, module, statement, subgoal`,
        )
      }
    }

    const idSet = new Set(stepIds)
    for (const step of this.steps) {
      for (const dep of step.dependsOn) {
        if (!idSet.has(dep)) {
          errors.push(`Step "${step.id}" depends_on unknown step "${dep}"`)
        }
      }
    }

    // Cycle detection via iterative DFS
    const adj: Record<string, string[]> = {}
    for (const step of this.steps) {
      if (idSet.has(step.id)) adj[step.id] = step.dependsOn.filter(d => idSet.has(d))
    }
    const WHITE = 0, GRAY = 1, BLACK = 2
    const colour: Record<string, number> = {}
    for (const id of stepIds) colour[id] = WHITE

    const hasCycle = (start: string): boolean => {
      const stack: [string, number, string[]][] = [[start, 0, adj[start] ?? []]]
      colour[start] = GRAY
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        const [node, idx, children] = frame
        if (idx >= children.length) {
          colour[node] = BLACK
          stack.pop()
          continue
        }
        frame[1]++
        const child = children[idx]
        if (!(child in colour)) continue
        if (colour[child] === GRAY) return true
        if (colour[child] === WHITE) {
          colour[child] = GRAY
          stack.push([child, 0, adj[child] ?? []])
        }
      }
      return false
    }

    for (const id of stepIds) {
      if (colour[id] === WHITE) {
        if (hasCycle(id)) {
          errors.push(`Dependency cycle detected involving step "${id}"`)
        }
      }
    }

    return errors
  }

  static fromJson(json: Record<string, unknown>): ProcessConcept {
    if (!json.id) {
      throw new ProcessConceptValidationError("Concept JSON missing required field 'id'")
    }

    const rawSteps = (json.steps as Record<string, unknown>[] | undefined) ?? []
    const steps: ProcessConceptStep[] = rawSteps.map((s, i) => {
      const step = s as Record<string, unknown>
      if (!step.id) {
        throw new ProcessConceptValidationError(`Step at index ${i} missing required field 'id'`)
      }
      const riskLevel = (step.risk_level ?? step.riskLevel ?? 'LOW') as string
      const abstractionLevel = (step.abstraction_level ?? step.abstractionLevel ?? 'module') as string
      if (!VALID_RISK_LEVELS.has(riskLevel as RiskLevelStr)) {
        throw new ProcessConceptValidationError(
          `Step "${step.id}": invalid riskLevel "${riskLevel}"`,
        )
      }
      return {
        id: String(step.id),
        description: String(step.description ?? ''),
        dependsOn: ((step.depends_on ?? step.dependsOn ?? []) as string[]).map(String),
        riskLevel: riskLevel as RiskLevelStr,
        abstractionLevel: abstractionLevel as AbstractionLevelStr,
        expectedTools: ((step.expected_tools ?? step.expectedTools ?? []) as string[]).map(String),
        successCriteria: ((step.success_criteria ?? step.successCriteria ?? []) as string[]).map(String),
        strategyHint: (step.strategy_hint ?? step.strategyHint ?? null) as string | null,
      }
    })

    const concept = new ProcessConcept({
      id: String(json.id),
      name: String(json.name ?? json.id),
      description: String(json.description ?? ''),
      successCriteria: ((json.success_criteria ?? json.successCriteria ?? []) as string[]).map(String),
      schemaVersion: String(json.schema_version ?? json.schemaVersion ?? '1'),
      steps,
    })

    const errors = concept.validate()
    if (errors.length > 0) {
      throw new ProcessConceptValidationError(`Concept validation failed: ${errors.join('; ')}`)
    }

    return concept
  }

  seedTaskGraph(taskGraph: TaskGraph): void {
    for (const step of this.steps) {
      const task: Task = {
        id: `${this.id}:${step.id}`,
        description: step.description,
        status: 'PENDING',
        risk_level: step.riskLevel,
        depends_on: step.dependsOn.map(dep => `${this.id}:${dep}`),
        parallel_write_domains: [],
        abstraction_level: ABSTRACTION_MAP[step.abstractionLevel] ?? 0,
        assigned_strategy: step.strategyHint,
      }
      taskGraph.tasks.push(task)
    }
    taskGraph.changed = true
  }
}
