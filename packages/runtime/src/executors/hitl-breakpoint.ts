import type { Node } from '@itsharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { resolveTemplate } from '../template'
import { FlowExecutionError, HITLTimeoutError } from '../errors'

function _validateResumePayload(payload: unknown, schema: object, nodeId: string): void {
  const s = schema as Record<string, unknown>
  if (s.required && Array.isArray(s.required)) {
    if (typeof payload !== 'object' || payload === null) {
      throw new FlowExecutionError({ nodeId, message: `HITL resume payload for node "${nodeId}" must be an object` })
    }
    const p = payload as Record<string, unknown>
    for (const field of s.required as string[]) {
      if (p[field] === undefined) {
        throw new FlowExecutionError({ nodeId, message: `HITL resume payload for node "${nodeId}" missing required field "${field}"` })
      }
    }
  }
}

export async function hitlBreakpointExecutor(node: Node, state: FlowState, context: ExecutionContext): Promise<ExecutorOutput> {
  if (node.type !== 'hitl_breakpoint') throw new Error(`hitlBreakpointExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const resolvedPrompt = node.prompt ? resolveTemplate(node.prompt, state) : ''
  const resumeSchema = (node.resume_schema ?? {}) as object

  let resolveWithPayload!: (payload: unknown) => void
  const resumePromise = new Promise<unknown>((resolve) => { resolveWithPayload = resolve })

  // Store validator+resolver — validation happens before resolution (so invalid payload doesn't resolve)
  context.hitlResolvers.set(node.id, (payload: unknown) => {
    _validateResumePayload(payload, resumeSchema, node.id)
    resolveWithPayload(payload)
  })

  // Persist HITL state BEFORE emitting pause event (invariant: persist first)
  await context.hitlPersistStore.set(`${node.id}:state`, { nodeId: node.id, prompt: resolvedPrompt, timestamp: Date.now() }, 'upsert')

  context.eventBus.emit({ type: 'flow:paused', nodeId: node.id, prompt: resolvedPrompt, resumeSchema })

  let payload: unknown

  try {
    if (node.timeout_seconds) {
      const timeoutMs = node.timeout_seconds * 1000
      const onTimeout = node.on_timeout ?? 'raise'

      const timeoutPromise = new Promise<null>((resolve, reject) =>
        setTimeout(() => {
          if (onTimeout === 'skip') resolve(null)
          else reject(new HITLTimeoutError({ nodeId: node.id, timeoutSeconds: node.timeout_seconds! }))
        }, timeoutMs)
      )

      payload = await Promise.race([resumePromise, timeoutPromise])
    } else {
      payload = await resumePromise
    }
  } finally {
    context.hitlResolvers.delete(node.id)
    await context.hitlPersistStore.delete(`${node.id}:state`)
  }

  const stateUpdate: Record<string, unknown> = {}
  if (node.output_key && payload !== null && payload !== undefined) {
    stateUpdate[node.output_key] = payload
  }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate }
}
