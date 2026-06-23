import type { Node } from '@buildaharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { evaluateExpr } from '../expr'

export async function conditionExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'condition') throw new Error(`conditionExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const stateData = state.toJSON()
  let routeToNodeId = node.default_target

  for (const branch of node.branches) {
    const cond = branch.condition
    let matched = false

    if (cond.type === 'expr' && cond.expr) {
      matched = evaluateExpr(cond.expr, stateData)
    } else if (cond.type === 'fn_ref' && cond.fn_ref) {
      const fn = context.functions.get(cond.fn_ref)
      if (fn) {
        matched = Boolean(fn(stateData))
      }
    }

    if (matched) {
      routeToNodeId = branch.target
      break
    }
  }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate: {}, routeToNodeId }
}
