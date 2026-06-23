import { describe, it, expect, vi, beforeEach } from 'vitest'
import { agentRoleExecutor } from './agent-role'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import type { ILLMClient, ChatMessage, ChatOptions, LLMStructuredResponse, ToolDefinition } from '../llm-client'
import type { AgentDef } from '@buildaharness/canvas'
import { ToolRegistry } from '../tools/registry'
import { FlowExecutionError } from '../errors'

function makeMockLLMClient(responses: LLMStructuredResponse[]): ILLMClient {
  let callIndex = 0
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) { yield '' },
    async callChatSync() { return '' },
    async callChatStructured(_msgs: ChatMessage[], _tools?: ToolDefinition[], _opts?: ChatOptions): Promise<LLMStructuredResponse> {
      const response = responses[callIndex] ?? { content: 'final answer' }
      callIndex++
      return response
    },
  }
}

const sampleAgent: AgentDef = {
  id: 'researcher',
  role: 'Research Analyst',
  backstory: 'Experienced data scientist',
  goal: 'Provide accurate analysis',
  model: 'claude-3-5-sonnet-20241022',
  tools: [],
  max_iter: 10,
}

function makeAgentRoleNode(agentRef: string, taskDescription: string, outputField?: string) {
  return {
    id: 'agent-1',
    type: 'agent_role' as const,
    position: { x: 0, y: 0 },
    config: {
      agent_ref: agentRef,
      task_description: taskDescription,
      output_field: outputField,
    },
  }
}

describe('AgentRoleExecutor', () => {
  describe('system prompt construction', () => {
    it('system prompt built from agent role + backstory + goal concatenated', async () => {
      const capturedMessages: ChatMessage[][] = []
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync() { return '' },
        async callChatStructured(msgs) {
          capturedMessages.push([...msgs])
          return { content: 'analysis complete' }
        },
      }

      const ctx = createExecutionContext({ llmClient: mockClient })
      ctx.agents.set('researcher', sampleAgent)

      const node = makeAgentRoleNode('researcher', 'Analyze the data')
      const state = new FlowState()

      await agentRoleExecutor(node, state, ctx)

      expect(capturedMessages.length).toBeGreaterThan(0)
      const firstMessages = capturedMessages[0]
      const systemMsg = firstMessages.find(m => m.role === 'system')
      expect(systemMsg).toBeDefined()
      expect(systemMsg!.content).toContain('Role: Research Analyst')
      expect(systemMsg!.content).toContain('Backstory: Experienced data scientist')
      expect(systemMsg!.content).toContain('Goal: Provide accurate analysis')
    })
  })

  describe('tool call loop', () => {
    it('LLM response with tool_call invokes tool and loops with tool result in messages', async () => {
      const toolExecute = vi.fn().mockResolvedValue({ data: 'tool_result_value' })
      const toolRegistry = new ToolRegistry()
      toolRegistry.register('search', {
        name: 'search',
        description: 'Search for information',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        execute: toolExecute,
      })

      // First call returns tool_call, second call returns final answer
      const responses: LLMStructuredResponse[] = [
        { content: '', toolCalls: [{ id: 'call-1', name: 'search', input: { query: 'test' } }] },
        { content: 'Here is the final answer based on the search.' },
      ]
      const mockClient = makeMockLLMClient(responses)

      const agent: AgentDef = { ...sampleAgent, tools: ['search'] }
      const ctx = createExecutionContext({ llmClient: mockClient, toolRegistry })
      ctx.agents.set('researcher', agent)

      const node = makeAgentRoleNode('researcher', 'Search for test data', 'result')
      const state = new FlowState()

      const output = await agentRoleExecutor(node, state, ctx)

      expect(toolExecute).toHaveBeenCalledWith({ query: 'test' })
      expect(output.stateUpdate['result']).toBe('Here is the final answer based on the search.')
    })

    it('multiple tool_calls in single LLM response all invoked before next LLM call', async () => {
      const searchExecute = vi.fn().mockResolvedValue({ result: 'search_data' })
      const calcExecute = vi.fn().mockResolvedValue({ result: 42 })
      const toolRegistry = new ToolRegistry()
      toolRegistry.register('search', { name: 'search', description: 'Search', execute: searchExecute })
      toolRegistry.register('calc', { name: 'calc', description: 'Calculate', execute: calcExecute })

      const responses: LLMStructuredResponse[] = [
        {
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'search', input: { query: 'test' } },
            { id: 'call-2', name: 'calc', input: { expr: '2+2' } },
          ],
        },
        { content: 'Both tools used successfully.' },
      ]
      const mockClient = makeMockLLMClient(responses)

      const agent: AgentDef = { ...sampleAgent, tools: ['search', 'calc'] }
      const ctx = createExecutionContext({ llmClient: mockClient, toolRegistry })
      ctx.agents.set('researcher', agent)

      const node = makeAgentRoleNode('researcher', 'Do both tasks')
      const state = new FlowState()

      await agentRoleExecutor(node, state, ctx)

      expect(searchExecute).toHaveBeenCalledTimes(1)
      expect(calcExecute).toHaveBeenCalledTimes(1)
    })

    it('LLM response with no tool_call terminates loop and writes output_field', async () => {
      const responses: LLMStructuredResponse[] = [
        { content: 'Direct answer without any tools.' },
      ]
      const mockClient = makeMockLLMClient(responses)

      const ctx = createExecutionContext({ llmClient: mockClient })
      ctx.agents.set('researcher', sampleAgent)

      const node = makeAgentRoleNode('researcher', 'Simple question', 'my_output')
      const state = new FlowState()

      const output = await agentRoleExecutor(node, state, ctx)

      expect(output.stateUpdate['my_output']).toBe('Direct answer without any tools.')
    })
  })

  describe('max_iter guard', () => {
    it('max_iter guard fires at exact count; partial answer returned with warning event emitted', async () => {
      // Agent always returns a tool call — will hit max_iter
      const toolExecute = vi.fn().mockResolvedValue({ data: 'result' })
      const toolRegistry = new ToolRegistry()
      toolRegistry.register('search', { name: 'search', description: 'Search', execute: toolExecute })

      const alwaysToolResponse: LLMStructuredResponse = {
        content: 'partial content',
        toolCalls: [{ id: 'call-1', name: 'search', input: { query: 'test' } }],
      }

      let callCount = 0
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync() { return '' },
        async callChatStructured() {
          callCount++
          return alwaysToolResponse
        },
      }

      const agent: AgentDef = { ...sampleAgent, tools: ['search'], max_iter: 3 }
      const ctx = createExecutionContext({ llmClient: mockClient, toolRegistry })
      ctx.agents.set('researcher', agent)

      const errorEvents: unknown[] = []
      ctx.eventBus.subscribe('node:error', (e) => errorEvents.push(e.error))

      const node = makeAgentRoleNode('researcher', 'Keep searching', 'partial_result')
      const state = new FlowState()

      const output = await agentRoleExecutor(node, state, ctx)

      // Should have called LLM exactly max_iter times
      expect(callCount).toBe(3)
      // Warning event should have been emitted
      expect(errorEvents).toHaveLength(1)
      expect((errorEvents[0] as FlowExecutionError).message).toContain('max_iter')
      // Partial answer still returned
      expect(output.stateUpdate['partial_result']).toBe('partial content')
    })
  })
})
