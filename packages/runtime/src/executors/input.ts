import type { Node } from '../spec/schema'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { z } from 'zod'

export async function inputExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'input') throw new Error(`inputExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const triggerData = (state.get('__triggerData__') ?? {}) as Record<string, unknown>

  if (node.output_schema) {
    const schema = z.object(
      Object.fromEntries(
        Object.entries((node.output_schema as Record<string, unknown>).properties as Record<string, unknown> ?? {}).map(([k]) => [k, z.unknown()])
      )
    )
    const result = schema.safeParse(triggerData)
    if (!result.success) {
      throw new TypeError(`Input node "${node.id}" trigger data failed schema validation: ${result.error.message}`)
    }
  }

  const stateUpdate: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(triggerData)) {
    stateUpdate[k] = v
  }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate }
}
