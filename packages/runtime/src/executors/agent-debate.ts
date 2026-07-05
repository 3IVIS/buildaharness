import type { Node, AgentDef } from '@buildaharness/canvas'
import type { FlowState } from '../state'
import type { ExecutionContext } from '../context'
import type { ExecutorOutput } from './index'
import type { ChatMessage } from '../llm-client'
import { FlowExecutionError, AbortedError } from '../errors'
import { evaluateExpr } from '../expr'
import { FlowState as FlowStateClass } from '../state'

interface DebateTurn { agentRef: string; content: string; round: number }

export async function agentDebateExecutor(node: Node, _state: FlowState, context: ExecutionContext): Promise<ExecutorOutput> {
  if (node.type !== 'agent_debate') throw new Error(`agentDebateExecutor called with node type "${node.type}"`)

  context.eventBus.emit({ type: 'node:start', nodeId: node.id, nodeType: node.type })
  const start = Date.now()

  const { config } = node
  const maxRounds = config.max_rounds ?? 10
  const agentRefs = config.agents

  const transcript: DebateTurn[] = []
  let converged = false

  for (let round = 1; round <= maxRounds && !converged; round++) {
    for (const agentRef of agentRefs) {
      if (context.signal.aborted) throw new AbortedError({ nodeId: node.id })

      const agent = context.agents.get(agentRef) as AgentDef | undefined
      if (!agent) throw new FlowExecutionError({ nodeId: node.id, message: `agent_debate "${node.id}": agent "${agentRef}" not found` })

      const messages: ChatMessage[] = []
      const systemParts: string[] = []
      if (agent.role) systemParts.push(`Role: ${agent.role}`)
      if (agent.backstory) systemParts.push(`Backstory: ${agent.backstory}`)
      if (agent.goal) systemParts.push(`Goal: ${agent.goal}`)
      if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n') })

      // All prior turns as conversation history
      for (const turn of transcript) {
        const roleLabel = turn.agentRef === agentRef ? 'assistant' : 'user'
        messages.push({ role: roleLabel, content: `[${turn.agentRef}]: ${turn.content}` })
      }

      const response = await context.llmClient.callChatSync(messages, { model: agent.model })
      transcript.push({ agentRef, content: response, round })
    }

    // Evaluate termination condition after each round
    if (config.termination_condition) {
      const cond = config.termination_condition
      if (cond.type === 'expr' && cond.expr) {
        const evalState = new FlowStateClass()
        evalState.patch({ transcript })
        try {
          const result = evaluateExpr(cond.expr, evalState.toJSON())
          if (result === true) { converged = true; break }
        } catch { /* ignore eval errors */ }
      } else if (cond.type === 'fn_ref' && cond.fn_ref) {
        const fn = context.functions.get(cond.fn_ref)
        if (fn) {
          const result = fn({ transcript })
          if (result.converged) { converged = true; break }
        }
      }
    }
  }

  const outputField = config.output_field ?? 'debate_output'
  context.eventBus.emit({ type: 'node:complete', nodeId: node.id, nodeType: node.type, durationMs: Date.now() - start })

  return { stateUpdate: { [outputField]: transcript } }
}
