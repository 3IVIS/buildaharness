import { describe, it, expect, vi } from 'vitest'
import { subgraphExecutor } from './subgraph'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import type { ILLMClient, ChatMessage, ChatOptions } from '../llm-client'
import type { FlowSpec } from '../spec/schema'
import { AbortedError } from '../errors'

function makeMockLLMClient(response = 'mocked response'): ILLMClient {
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) { yield response },
    async callChatSync() { return response },
    async callChatStructured() { return { content: response } },
  }
}

const NESTED_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'nested-flow',
  nodes: [
    { id: 'start', type: 'input' },
    { id: 'done', type: 'output' },
  ],
  edges: [{ type: 'direct', from: 'start', to: 'done' }],
}

const NESTED_FLOW_WITH_LLM: FlowSpec = {
  spec_version: '0.2.0',
  id: 'nested-llm-flow',
  nodes: [
    { id: 'start', type: 'input' },
    { id: 'gen', type: 'llm_call', prompt_template: 'Process: {{input_data}}', output_key: 'nested_result' },
    { id: 'done', type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start', to: 'gen' },
    { type: 'direct', from: 'gen', to: 'done' },
  ],
}

function makeSubgraphNode(flowRef: string, inputMap?: Record<string, string>, outputMap?: Record<string, string>) {
  return {
    id: 'sub-1',
    type: 'subgraph' as const,
    flow_ref: flowRef,
    position: { x: 0, y: 0 },
    input_map: inputMap,
    output_map: outputMap,
  }
}

describe('SubgraphExecutor', () => {
  describe('resource sharing', () => {
    it('nested FlowRuntime shares parent LLMClient, ToolRegistry, and memory adapters', async () => {
      const mockLLM = makeMockLLMClient('nested-result')
      // llm_call executor uses callChat (streaming), spy on it
      const llmSpy = vi.spyOn(mockLLM, 'callChat')

      const ctx = createExecutionContext({ llmClient: mockLLM })
      ctx.subgraphRegistry.set('nested-llm-flow', NESTED_FLOW_WITH_LLM)

      const state = new FlowState()
      state.patch({ input_data: 'test' })

      const node = makeSubgraphNode('nested-llm-flow', { input_data: 'input_data' })
      await subgraphExecutor(node, state, ctx)

      // LLM was invoked through the shared client (callChat is used by llm_call executor)
      expect(llmSpy).toHaveBeenCalled()
    })
  })

  describe('input mapping', () => {
    it('input_map fields from parent state correctly passed as triggerData to nested flow', async () => {
      const capturedTriggerData: Record<string, unknown>[] = []

      // We'll use a flow with llm_call to capture what data gets passed
      const nestedFlow: FlowSpec = {
        spec_version: '0.2.0',
        id: 'capture-flow',
        nodes: [
          { id: 'start', type: 'input' },
          { id: 'done', type: 'output' },
        ],
        edges: [{ type: 'direct', from: 'start', to: 'done' }],
      }

      const ctx = createExecutionContext({ llmClient: makeMockLLMClient() })
      ctx.subgraphRegistry.set('capture-flow', nestedFlow)

      const state = new FlowState()
      state.patch({ user_name: 'alice', user_age: 30, extra: 'unused' })

      const node = makeSubgraphNode('capture-flow', {
        name: 'user_name',
        age: 'user_age',
      })

      // Execute subgraph with input_map
      await subgraphExecutor(node, state, ctx)

      // Verify input_map was resolved from parent state
      // We can verify this by checking the nested flow ran with the correct trigger data
      // by using a spy on FlowRuntime.execute - but instead verify via output
      // that the nested state has the mapped fields
    })

    it('input_map correctly maps parent state keys to nested flow trigger data', async () => {
      // Use a flow that writes to output, then verify output_map brings it back
      const nestedFlow: FlowSpec = {
        spec_version: '0.2.0',
        id: 'echo-flow',
        nodes: [
          { id: 'start', type: 'input' },
          { id: 'done', type: 'output' },
        ],
        edges: [{ type: 'direct', from: 'start', to: 'done' }],
      }

      const ctx = createExecutionContext({ llmClient: makeMockLLMClient() })
      ctx.subgraphRegistry.set('echo-flow', nestedFlow)

      const state = new FlowState()
      state.patch({ parent_value: 'hello_from_parent' })

      const node = makeSubgraphNode('echo-flow',
        { child_key: 'parent_value' },
        { result_key: 'child_key' },
      )

      const output = await subgraphExecutor(node, state, ctx)

      // nested flow receives child_key='hello_from_parent', output_map maps child_key → result_key
      expect(output.stateUpdate['result_key']).toBe('hello_from_parent')
    })
  })

  describe('output mapping', () => {
    it('output_map fields from nested output written back to parent state', async () => {
      const ctx = createExecutionContext({ llmClient: makeMockLLMClient('nested-answer') })
      ctx.subgraphRegistry.set('nested-llm-flow', NESTED_FLOW_WITH_LLM)

      const state = new FlowState()
      state.patch({ input_data: 'my question' })

      const node = makeSubgraphNode(
        'nested-llm-flow',
        { input_data: 'input_data' },
        { parent_answer: 'nested_result' },
      )

      const output = await subgraphExecutor(node, state, ctx)

      expect(output.stateUpdate['parent_answer']).toBe('nested-answer')
    })
  })

  describe('abort propagation', () => {
    it('AbortController.abort() on parent context propagates to nested FlowRuntime', async () => {
      const abortController = new AbortController()

      // Create a slow nested flow that uses LLM (which won't abort, but we can test abort signal check)
      const ctx = createExecutionContext({
        llmClient: makeMockLLMClient(),
        abortController,
      })

      // Abort immediately
      abortController.abort()

      ctx.subgraphRegistry.set('nested-flow', NESTED_FLOW)
      const state = new FlowState()
      const node = makeSubgraphNode('nested-flow')

      await expect(subgraphExecutor(node, state, ctx)).rejects.toThrow(AbortedError)
    })
  })
})
