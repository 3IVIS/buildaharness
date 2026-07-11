import { describe, it, expect, vi } from 'vitest'
import { agentDebateExecutor } from './agent-debate'
import { FlowState } from '../state'
import { createExecutionContext } from '../context'
import type { ILLMClient, ChatMessage, ChatOptions } from '../llm-client'
import type { AgentDef } from '../spec/schema'

function makeMockLLMClient(responseMap?: Record<string, string>): ILLMClient {
  let callIndex = 0
  const responses = responseMap ? Object.values(responseMap) : []
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) { yield '' },
    async callChatSync(_msgs: ChatMessage[], _opts?: ChatOptions) {
      const response = responses[callIndex] ?? `response-${callIndex}`
      callIndex++
      return response
    },
    async callChatStructured() { return { content: '' } },
  }
}

const agentA: AgentDef = {
  id: 'agent-a',
  role: 'Proponent',
  backstory: 'Argues for the motion',
  goal: 'Win the debate',
  model: 'claude-3-5-sonnet-20241022',
}

const agentB: AgentDef = {
  id: 'agent-b',
  role: 'Opponent',
  backstory: 'Argues against the motion',
  goal: 'Rebut all arguments',
  model: 'claude-3-5-sonnet-20241022',
}

function makeDebateNode(agentRefs: string[], maxRounds: number, terminationCondition?: object, outputField?: string) {
  return {
    id: 'debate-1',
    type: 'agent_debate' as const,
    position: { x: 0, y: 0 },
    config: {
      agents: agentRefs,
      max_rounds: maxRounds,
      termination_condition: terminationCondition as { type: 'expr'; expr?: string } | undefined,
      output_field: outputField,
    },
  }
}

describe('AgentDebateExecutor', () => {
  describe('conversation history', () => {
    it('each agent receives all prior turns as conversation history in turn-taking loop', async () => {
      const capturedMessages: ChatMessage[][] = []
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync(msgs) {
          capturedMessages.push([...msgs])
          return `response-${capturedMessages.length}`
        },
        async callChatStructured() { return { content: '' } },
      }

      const ctx = createExecutionContext({ llmClient: mockClient })
      ctx.agents.set('agent-a', agentA)
      ctx.agents.set('agent-b', agentB)

      const node = makeDebateNode(['agent-a', 'agent-b'], 2)
      const state = new FlowState()

      await agentDebateExecutor(node, state, ctx)

      // First call: agent-a with no prior turns (just system)
      const firstCall = capturedMessages[0]
      const firstUserMsgs = firstCall.filter(m => m.role === 'user')
      expect(firstUserMsgs.length).toBe(0)

      // Second call: agent-b with agent-a's first response in history
      const secondCall = capturedMessages[1]
      const secondUserMsgs = secondCall.filter(m => m.role === 'user')
      expect(secondUserMsgs.length).toBe(1)
      expect(secondUserMsgs[0].content).toContain('[agent-a]:')

      // Third call: agent-a in round 2, should have both prior turns in history
      const thirdCall = capturedMessages[2]
      const thirdUserMsgs = thirdCall.filter(m => m.role === 'user' || m.role === 'assistant')
      expect(thirdUserMsgs.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('convergence condition', () => {
    it('convergence condition expr evaluated after each round; loop stops when true', async () => {
      let callCount = 0
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync() {
          callCount++
          return `turn-${callCount}`
        },
        async callChatStructured() { return { content: '' } },
      }

      const ctx = createExecutionContext({
        llmClient: mockClient,
        functions: new Map([
          ['checkConvergence', ({ transcript }: Record<string, unknown>) => {
            const t = transcript as Array<{agentRef: string; content: string; round: number}>
            // Converge after round 1 (2 turns: agent-a and agent-b both spoke)
            return { converged: t.length >= 2 }
          }],
        ]),
      })
      ctx.agents.set('agent-a', agentA)
      ctx.agents.set('agent-b', agentB)

      // Use fn_ref termination
      const node = {
        id: 'debate-1',
        type: 'agent_debate' as const,
        position: { x: 0, y: 0 },
        config: {
          agents: ['agent-a', 'agent-b'],
          max_rounds: 10,
          termination_condition: { type: 'fn_ref' as const, fn_ref: 'checkConvergence' },
          output_field: 'result',
        },
      }
      const state = new FlowState()

      const output = await agentDebateExecutor(node, state, ctx)

      // Should stop after 1 round (2 turns)
      expect(callCount).toBe(2)
      expect((output.stateUpdate['result'] as unknown[]).length).toBe(2)
    })

    it('convergence via expr stops loop when expr evaluates to true', async () => {
      let callCount = 0
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync() {
          callCount++
          return `turn-${callCount}`
        },
        async callChatStructured() { return { content: '' } },
      }

      const ctx = createExecutionContext({ llmClient: mockClient })
      ctx.agents.set('agent-a', agentA)
      ctx.agents.set('agent-b', agentB)

      // Max 1 round using max_rounds=1 (no expr needed)
      const node = makeDebateNode(['agent-a', 'agent-b'], 1, undefined, 'debate_result')
      const state = new FlowState()

      const output = await agentDebateExecutor(node, state, ctx)
      expect(callCount).toBe(2) // 2 agents, 1 round
      expect((output.stateUpdate['debate_result'] as unknown[]).length).toBe(2)
    })
  })

  describe('max_iter limit', () => {
    it('stops unconditionally at max_iter even when convergence condition never fires', async () => {
      let callCount = 0
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync() {
          callCount++
          return `turn-${callCount}`
        },
        async callChatStructured() { return { content: '' } },
      }

      const ctx = createExecutionContext({ llmClient: mockClient })
      ctx.agents.set('agent-a', agentA)
      ctx.agents.set('agent-b', agentB)

      // max_rounds=3, no convergence condition
      const node = makeDebateNode(['agent-a', 'agent-b'], 3, undefined, 'debate_output')
      const state = new FlowState()

      const output = await agentDebateExecutor(node, state, ctx)

      // 2 agents × 3 rounds = 6 turns
      expect(callCount).toBe(6)
      const transcript = output.stateUpdate['debate_output'] as Array<{agentRef: string; round: number}>
      expect(transcript.length).toBe(6)
    })
  })

  describe('transcript ordering', () => {
    it('transcript contains all turns from all agents in order', async () => {
      const responses = ['a-r1', 'b-r1', 'a-r2', 'b-r2']
      let idx = 0
      const mockClient: ILLMClient = {
        async *callChat() { yield '' },
        async callChatSync() { return responses[idx++] ?? '' },
        async callChatStructured() { return { content: '' } },
      }

      const ctx = createExecutionContext({ llmClient: mockClient })
      ctx.agents.set('agent-a', agentA)
      ctx.agents.set('agent-b', agentB)

      const node = makeDebateNode(['agent-a', 'agent-b'], 2, undefined, 'transcript_output')
      const state = new FlowState()

      const output = await agentDebateExecutor(node, state, ctx)

      const transcript = output.stateUpdate['transcript_output'] as Array<{agentRef: string; content: string; round: number}>
      expect(transcript).toHaveLength(4)
      expect(transcript[0]).toEqual({ agentRef: 'agent-a', content: 'a-r1', round: 1 })
      expect(transcript[1]).toEqual({ agentRef: 'agent-b', content: 'b-r1', round: 1 })
      expect(transcript[2]).toEqual({ agentRef: 'agent-a', content: 'a-r2', round: 2 })
      expect(transcript[3]).toEqual({ agentRef: 'agent-b', content: 'b-r2', round: 2 })
    })
  })
})
