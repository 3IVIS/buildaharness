import { describe, it, expect, vi } from 'vitest'
import { FlowRuntime } from './runtime'
import { createExecutionContext } from './context'
import type { ILLMClient, ChatMessage, ChatOptions } from './llm-client'
import type { FlowSpec } from './spec/schema'

function mockLLMClient(): ILLMClient {
  return {
    async *callChat(_msgs: ChatMessage[], _opts?: ChatOptions) { yield 'mocked' },
    async callChatSync() { return 'mocked' },
    async callChatStructured() { return { content: 'mocked' } },
  }
}

/**
 * Content Moderation Integration Test
 *
 * Flow: input → condition (routes on severity) → hitl_breakpoint → output
 *
 * severity=high routes to HITL pause.
 * resume({decision: 'reject', reviewer_note: 'spam'}) should write to state.
 * output node should be reached after resume.
 */
const CONTENT_MOD_FLOW: FlowSpec = {
  spec_version: '0.2.0',
  id: 'content-mod-flow',
  nodes: [
    { id: 'start', type: 'input' },
    {
      id: 'route',
      type: 'condition',
      branches: [
        {
          condition: { type: 'expr', expr: "$.state.severity == 'high'" },
          target: 'review',
        },
      ],
      default_target: 'done',
    },
    {
      id: 'review',
      type: 'hitl_breakpoint',
      prompt: 'Content flagged as {{severity}}. Please review and decide.',
      resume_schema: {
        type: 'object',
        required: ['decision'],
        properties: {
          decision: { type: 'string', enum: ['approve', 'reject'] },
          reviewer_note: { type: 'string' },
        },
      },
      output_key: 'review_result',
    },
    { id: 'done', type: 'output' },
  ],
  edges: [
    { type: 'direct', from: 'start', to: 'route' },
    { type: 'direct', from: 'route', to: 'review' },
    { type: 'direct', from: 'route', to: 'done' },
    { type: 'direct', from: 'review', to: 'done' },
  ],
}

describe('FlowRuntime HITL Integration', () => {
  it('content moderation: severity=high → status=paused → resume with decision → output node reached', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })

    const events: string[] = []
    ctx.eventBus.subscribe('flow:paused', (e) => {
      events.push(`paused:${e.nodeId}`)
      // Resume via runtime after we see the pause
      setTimeout(() => {
        runtime.resume('review', { decision: 'reject', reviewer_note: 'spam' })
      }, 0)
    })
    ctx.eventBus.subscribe('node:complete', (e) => events.push(`complete:${e.nodeId}`))

    const state = await runtime.execute(CONTENT_MOD_FLOW, { severity: 'high', content: 'buy pills' }, ctx)

    // flow:paused event was emitted
    expect(events).toContain('paused:review')

    // output node was reached after resume
    expect(events).toContain('complete:done')

    // review result written to state
    const reviewResult = state.get('review_result') as { decision: string; reviewer_note: string }
    expect(reviewResult.decision).toBe('reject')
    expect(reviewResult.reviewer_note).toBe('spam')
  })

  it('content moderation: severity=low → skips HITL → output node reached directly', async () => {
    const runtime = new FlowRuntime()
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })

    const pausedEvents: string[] = []
    ctx.eventBus.subscribe('flow:paused', (e) => pausedEvents.push(e.nodeId))

    const state = await runtime.execute(CONTENT_MOD_FLOW, { severity: 'low', content: 'hello world' }, ctx)

    // No HITL pause for low severity
    expect(pausedEvents).toHaveLength(0)
    expect(state.get('review_result')).toBeUndefined()
  })

  it('resume() with invalid nodeId throws FlowExecutionError', () => {
    const runtime = new FlowRuntime()
    // Set up a fake active context
    const ctx = createExecutionContext({ llmClient: mockLLMClient() })
    runtime._activeContext = ctx

    expect(() => {
      runtime.resume('nonexistent-node', { decision: 'approve' })
    }).toThrow('No active HITL pause')
  })
})
