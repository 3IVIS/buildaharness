import type { WorldModel } from '../state/world-model.js'
import type { TaskGraph } from '../state/task-graph.js'

export type RiskEstimate = 'LOW' | 'MEDIUM' | 'HIGH'
export type ModuleType = 'test' | 'business_logic' | 'infrastructure'

export interface RiskableAction {
  module_type: ModuleType
  affected_files?: string[]
  lines_affected?: number
  functions_affected?: number
  metadata: Record<string, unknown>
}

const MAX_LINES = 500
const MAX_FUNCTIONS = 20

export function estimateRisk(
  action: RiskableAction,
  taskGraph: TaskGraph,
  _worldModel: WorldModel,
): RiskEstimate {
  // Module type provides a base that dominates for extreme values
  if (action.module_type === 'infrastructure') {
    action.metadata['reduce_edit_size'] = true
    action.metadata['increase_verification'] = true
    return 'HIGH'
  }
  if (action.module_type === 'test') {
    return 'LOW'
  }

  // business_logic: composite from file_centrality + change_scope
  const affectedFiles = action.affected_files ?? []
  const allDomains = taskGraph.tasks.flatMap(t => t.parallel_write_domains)
  const fileCentrality = affectedFiles.length === 0 ? 0 :
    affectedFiles.reduce((sum, f) => sum + allDomains.filter(d => d.includes(f)).length, 0) /
    (Math.max(allDomains.length, 1) * affectedFiles.length)

  const lineScore = Math.min(1, (action.lines_affected ?? 0) / MAX_LINES)
  const funcScore = Math.min(1, (action.functions_affected ?? 0) / MAX_FUNCTIONS)
  const changeScope = (lineScore + funcScore) / 2

  const MODULE_SCORE_BUSINESS = 0.5
  const composite = 0.3 * fileCentrality + 0.4 * changeScope + 0.3 * MODULE_SCORE_BUSINESS

  let risk: RiskEstimate
  if (composite >= 0.5) {
    risk = 'HIGH'
  } else if (composite >= 0.3) {
    risk = 'MEDIUM'
  } else {
    risk = 'LOW'
  }

  if (risk === 'HIGH') {
    action.metadata['reduce_edit_size'] = true
    action.metadata['increase_verification'] = true
  }

  return risk
}
