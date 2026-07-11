import type { Node, ParallelJoinNode } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'

export async function parallelJoinExecutor(
  node: Node,
  _state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'parallel_join') {
    throw new Error(`parallelJoinExecutor called with node type "${node.type}"`)
  }

  const joinNode = node as ParallelJoinNode
  const reducer = joinNode.join_reducer ?? 'merge'

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  // Retrieve branch states accumulated by FlowRuntime._runBranches()
  const branchStates: FlowState[] = context.branchResults.get(node.id) ?? []

  const stateUpdate: Record<string, unknown> = {}
  const seenKeys = new Set<string>()

  for (const branchState of branchStates) {
    const branchData = branchState.toJSON()
    // Skip internal trigger data
    delete branchData['__triggerData__']

    for (const [key, value] of Object.entries(branchData)) {
      if (seenKeys.has(key)) {
        // Key conflict — warn
        console.warn(
          `parallel_join node "${node.id}": key conflict on "${key}" — applying ${reducer} strategy`,
        )
      }
      seenKeys.add(key)

      if (reducer === 'append') {
        const existing = stateUpdate[key]
        if (Array.isArray(existing) && Array.isArray(value)) {
          stateUpdate[key] = [...existing, ...value]
        } else if (Array.isArray(existing)) {
          // existing is array but new value is not — append element
          stateUpdate[key] = [...existing, value]
        } else if (Array.isArray(value)) {
          // new value is array — use it as base if no existing, or concat
          stateUpdate[key] = existing !== undefined ? [existing, ...value] : value
        } else {
          // Neither is an array — last-write-wins
          stateUpdate[key] = value
        }
      } else {
        // 'merge' and 'fn_ref' (fn_ref treated as merge for now): last-write-wins
        stateUpdate[key] = value
      }
    }
  }

  context.eventBus.emit({
    type: 'node:complete',
    nodeId: node.id,
    nodeType: node.type,
    durationMs: Date.now() - start,
  })

  return { stateUpdate }
}
