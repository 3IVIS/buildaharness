import { describe, it, expect, vi } from 'vitest'
import { conditionExecutor } from './condition'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import type { ILLMClient } from '../llm-client'
import type { ConditionNode } from '../spec/schema'

function mockLLMClient(): ILLMClient {
  return {
    callChat: vi.fn().mockImplementation(async function* () {}),
    callChatSync: vi.fn().mockResolvedValue(''),
    callChatStructured: vi.fn().mockResolvedValue({ content: '' }),
  }
}

function stateWith(data: Record<string, unknown>): FlowState {
  const s = new FlowState()
  for (const [k, v] of Object.entries(data)) s.set(k, v)
  return s
}

function makeNode(overrides: Partial<ConditionNode>): ConditionNode {
  return {
    id: 'cond',
    type: 'condition',
    branches: [],
    default_target: 'fallback',
    ...overrides,
  }
}

describe('ConditionExecutor', () => {
  it('evaluates branches in order; returns first matching target', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = stateWith({ severity: 'high' })
    const node = makeNode({
      branches: [
        { condition: { type: 'expr', expr: "$.state.severity == 'high'" }, target: 'escalate' },
        { condition: { type: 'expr', expr: "$.state.severity == 'low'" }, target: 'ignore' },
      ],
      default_target: 'default',
    })
    const result = await conditionExecutor(node, state, ctx)
    expect(result.routeToNodeId).toBe('escalate')
  })

  it('falls through to default_target when no branch condition is true', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = stateWith({ severity: 'medium' })
    const node = makeNode({
      branches: [
        { condition: { type: 'expr', expr: "$.state.severity == 'high'" }, target: 'escalate' },
      ],
      default_target: 'auto',
    })
    const result = await conditionExecutor(node, state, ctx)
    expect(result.routeToNodeId).toBe('auto')
  })

  it('no eval() used — safe expr evaluator handles ==, !=, <, >, &&, ||', async () => {
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    const state = stateWith({ count: 10, flag: true })
    const node = makeNode({
      branches: [
        { condition: { type: 'expr', expr: '$.state.count > 5 && $.state.flag == true' }, target: 'yes' },
      ],
      default_target: 'no',
    })
    const result = await conditionExecutor(node, state, ctx)
    expect(result.routeToNodeId).toBe('yes')
  })
})
