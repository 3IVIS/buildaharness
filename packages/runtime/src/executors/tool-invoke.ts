import type { Node } from '@buildaharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { resolveValue } from '../template'

function navigatePath(obj: unknown, path: string): unknown {
  if (path === '') return obj
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export async function toolInvokeExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'tool_invoke') throw new Error(`toolInvokeExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  // Build args from input_map
  const args: Record<string, unknown> = {}
  if (node.input_map) {
    for (const [argName, expr] of Object.entries(node.input_map)) {
      args[argName] = resolveValue(expr, state)
    }
  }

  // Invoke tool (may throw UnknownToolError)
  const result = await context.toolRegistry.invoke(node.id, node.tool_id, args)

  // Build stateUpdate from output_map
  const stateUpdate: Record<string, unknown> = {}
  if (node.output_map && Object.keys(node.output_map).length > 0) {
    for (const [stateKey, outputPath] of Object.entries(node.output_map)) {
      stateUpdate[stateKey] = navigatePath(result, outputPath)
    }
  } else {
    // No output_map: write entire result to state[tool_id]
    stateUpdate[node.tool_id] = result
  }

  const durationMs = Date.now() - start

  context.eventBus.emit({
    type: 'node:complete',
    nodeId: node.id,
    nodeType: node.type,
    durationMs,
    metadata: { tool_id: node.tool_id, durationMs },
  })

  return { stateUpdate }
}
