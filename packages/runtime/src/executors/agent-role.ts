import type { Node, AgentDef } from '@buildaharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import type { ChatMessage, ToolDefinition } from '../llm-client'
import { FlowExecutionError, AbortedError } from '../errors'
import { resolveTemplate } from '../template'

export async function agentRoleExecutor(node: Node, state: FlowState, context: ExecutionContext): Promise<ExecutorOutput> {
  if (node.type !== 'agent_role') throw new Error(`agentRoleExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const { config } = node
  const agent = context.agents.get(config.agent_ref) as AgentDef | undefined
  if (!agent) {
    throw new FlowExecutionError({ nodeId: node.id, message: `agent_role node "${node.id}": agent "${config.agent_ref}" not found` })
  }

  // Build system prompt from role + backstory + goal
  const systemParts: string[] = []
  if (agent.role) systemParts.push(`Role: ${agent.role}`)
  if (agent.backstory) systemParts.push(`Backstory: ${agent.backstory}`)
  if (agent.goal) systemParts.push(`Goal: ${agent.goal}`)

  const messages: ChatMessage[] = []
  if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n') })
  messages.push({ role: 'user', content: resolveTemplate(config.task_description, state) })

  // Build tool definitions
  const toolDefs: ToolDefinition[] = []
  for (const toolName of agent.tools ?? []) {
    const toolDef = context.toolRegistry.get(toolName)
    if (toolDef) {
      toolDefs.push({ name: toolDef.name, description: toolDef.description, input_schema: (toolDef as {inputSchema?: Record<string, unknown>}).inputSchema ?? { type: 'object', properties: {} } })
    }
  }

  const maxIter = agent.max_iter ?? 10
  let lastContent = ''
  let iterCount = 0
  let done = false

  while (iterCount < maxIter) {
    if (context.signal.aborted) throw new AbortedError({ nodeId: node.id })

    const response = await context.llmClient.callChatStructured(messages, toolDefs, { model: agent.model })
    iterCount++
    lastContent = response.content

    if (!response.toolCalls || response.toolCalls.length === 0) {
      done = true
      break
    }

    // Add assistant turn and execute all tool calls before next LLM call
    messages.push({ role: 'assistant', content: response.content || `[tool calls: ${response.toolCalls.map(tc => tc.name).join(', ')}]` })

    for (const tc of response.toolCalls) {
      const result = await context.toolRegistry.invoke(node.id, tc.name, tc.input)
      messages.push({ role: 'tool', content: JSON.stringify(result) })
    }
  }

  if (!done) {
    // max_iter reached — emit warning, return partial answer
    context.eventBus.emit({ type: 'node:error', nodeId: node.id, error: new FlowExecutionError({ nodeId: node.id, message: `agent_role "${node.id}" reached max_iter (${maxIter}) — returning partial answer` }) })
  }

  const outputField = config.output_field ?? 'agent_output'
  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate: { [outputField]: lastContent } }
}
