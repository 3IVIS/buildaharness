import type { WorldModel } from '../state/world-model.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import { TaskGraph } from '../state/task-graph.js'

export class GraphCycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphCycleError'
  }
}

function detectCycles(taskGraph: TaskGraph): void {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const t of taskGraph.tasks) color.set(t.id, WHITE)
  const taskMap = new Map(taskGraph.tasks.map(t => [t.id, t]))

  const dfs = (id: string): void => {
    color.set(id, GRAY)
    for (const depId of (taskMap.get(id)?.depends_on ?? [])) {
      const c = color.get(depId) ?? WHITE
      if (c === GRAY) throw new GraphCycleError(`Cycle detected in task graph: "${depId}" is part of a cycle`)
      if (c === WHITE) dfs(depId)
    }
    color.set(id, BLACK)
  }

  for (const t of taskGraph.tasks) {
    if ((color.get(t.id) ?? WHITE) === WHITE) dfs(t.id)
  }
}

function updateConflictProbabilities(taskGraph: TaskGraph): void {
  const tasks = taskGraph.tasks
  if (tasks.length < 2) return

  const allDomains = new Set<string>()
  for (const t of tasks) {
    for (const d of t.parallel_write_domains) allDomains.add(d)
  }

  const domains = [...allDomains].sort()
  for (let i = 0; i < domains.length; i++) {
    for (let j = i + 1; j < domains.length; j++) {
      const domA = domains[i], domB = domains[j]
      if (taskGraph.getConflictProbability(domA, domB) === 0) {
        const countA = tasks.filter(t => t.parallel_write_domains.includes(domA)).length
        const countB = tasks.filter(t => t.parallel_write_domains.includes(domB)).length
        if (countA > 0 && countB > 0) {
          taskGraph.setConflictProbability(domA, domB, Math.min(1, (countA + countB) / (2 * tasks.length)))
        }
      }
    }
    // also handle same-domain pairs (two tasks writing the same single domain)
    const domA = domains[i]
    if (taskGraph.getConflictProbability(domA, domA) === 0) {
      const countA = tasks.filter(t => t.parallel_write_domains.includes(domA)).length
      if (countA >= 2) {
        taskGraph.setConflictProbability(domA, domA, Math.min(1, countA / tasks.length))
      }
    }
  }
}

export function updateTaskGraph(
  _objective: string,
  _worldModel: WorldModel,
  _hypothesisSet: HypothesisSet,
  taskGraph: TaskGraph,
): void {
  detectCycles(taskGraph)
  updateConflictProbabilities(taskGraph)
}
