import type { Node } from '@itsharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import { resolveTemplate } from '../template'

export async function llmCallExecutor(
  node: Node,
  state: FlowState,
  context: ExecutionContext,
): Promise<ExecutorOutput> {
  if (node.type !== 'llm_call') throw new Error(`llmCallExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const messages: { role: 'system' | 'user'; content: string }[] = []

  if (node.system_prompt) {
    messages.push({ role: 'system', content: resolveTemplate(node.system_prompt, state) })
  }

  const userPrompt = node.prompt_template ? resolveTemplate(node.prompt_template, state) : ''
  messages.push({ role: 'user', content: userPrompt })

  const params = node.model_params ?? {}
  const options = {
    model: node.model,
    temperature: params.temperature,
    maxTokens: params.max_tokens,
  }

  let fullText = ''
  let tokenCount = 0

  for await (const token of context.llmClient.callChat(messages, options)) {
    fullText += token
    tokenCount++
    context.eventBus.emit({ type: 'token:chunk', nodeId: node.id, token })
  }

  let outputValue: unknown = fullText

  if (node.structured_output?.schema) {
    try {
      outputValue = JSON.parse(fullText)
    } catch {
      throw new TypeError(`llm_call node "${node.id}" expected JSON output but got non-JSON response`)
    }
    // Basic structural validation — check required fields if schema has them
    const schema = node.structured_output.schema as Record<string, unknown>
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required as string[]) {
        if ((outputValue as Record<string, unknown>)[field] === undefined) {
          throw new TypeError(`llm_call node "${node.id}" structured output missing required field "${field}"`)
        }
      }
    }
  }

  const outputKey = node.output_key ?? 'llm_output'
  const stateUpdate: Record<string, unknown> = { [outputKey]: outputValue }

  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start, tokenCount })

  return { stateUpdate, tokenCount }
}
