import { renderHook, act, waitFor } from '@testing-library/react'
import { useHarness } from './use-harness'
import type { ILLMClient, ChatMessage, ChatOptions, ToolDefinition, LLMStructuredResponse } from '@buildaharness/runtime'

// ─── Mock LLM client ─────────────────────────────────────────────────────────

function makeMockLLM(response = 'hello'): ILLMClient {
  return {
    async *callChat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<string> {
      yield response
    },
    async callChatSync(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
      return response
    },
    async callChatStructured(
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
      _options?: ChatOptions,
    ): Promise<LLMStructuredResponse> {
      return { content: response }
    },
  }
}

// Minimal valid FlowSpec: input → llm_call → output
function makeSimpleFlowSpec(llmOutputKey = 'answer') {
  return {
    spec_version: '0.2.0' as const,
    id: 'test-flow',
    nodes: [
      { id: 'n-input', type: 'input' as const, label: 'Start' },
      {
        id: 'n-llm',
        type: 'llm_call' as const,
        label: 'LLM',
        prompt_template: 'Say something',
        output_key: llmOutputKey,
      },
      { id: 'n-output', type: 'output' as const, label: 'End' },
    ],
    edges: [
      { id: 'e1', type: 'direct' as const, from: 'n-input', to: 'n-llm' },
      { id: 'e2', type: 'direct' as const, from: 'n-llm', to: 'n-output' },
    ],
  }
}

// FlowSpec that crashes on a node with an unregistered type
function makeErrorFlowSpec() {
  return {
    spec_version: '0.2.0' as const,
    id: 'error-flow',
    nodes: [
      { id: 'n-input', type: 'input' as const, label: 'Start' },
      // 'transform' in fn_ref mode with a non-existent fn → throws at runtime
      { id: 'n-bad', type: 'transform' as const, mode: 'fn_ref' as const, label: 'Bad', fn_ref: '__nonexistent_fn__' },
    ],
    edges: [{ id: 'e1', type: 'direct' as const, from: 'n-input', to: 'n-bad' }],
  }
}

const BASE_OPTIONS = { llmClient: makeMockLLM() }

// ─── Status transitions ───────────────────────────────────────────────────────

describe('useHarness — status transitions', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useHarness(makeSimpleFlowSpec(), BASE_OPTIONS))
    expect(result.current.status).toBe('idle')
  })

  it('transitions idle → running → complete on happy path', async () => {
    const { result } = renderHook(() => useHarness(makeSimpleFlowSpec(), BASE_OPTIONS))

    act(() => { result.current.run() })
    expect(result.current.status).toBe('running')

    await waitFor(() => expect(result.current.status).toBe('complete'))
  })

  it('sets status to error when executor throws', async () => {
    const { result } = renderHook(() => useHarness(makeErrorFlowSpec(), BASE_OPTIONS))

    act(() => { result.current.run() })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBeTruthy()
  })

  it('reset() returns to idle from complete', async () => {
    const { result } = renderHook(() => useHarness(makeSimpleFlowSpec(), BASE_OPTIONS))

    act(() => { result.current.run() })
    await waitFor(() => expect(result.current.status).toBe('complete'))

    act(() => { result.current.reset() })
    expect(result.current.status).toBe('idle')
    expect(result.current.state).toEqual({})
    expect(result.current.nodeStats).toEqual({})
  })

  it('abort() during run sets status to error', async () => {
    let resolveLLM!: () => void
    const slowLLM: ILLMClient = {
      async *callChat() {
        await new Promise<void>((resolve) => { resolveLLM = resolve })
        yield 'done'
      },
      async callChatSync() {
        await new Promise<void>((resolve) => { resolveLLM = resolve })
        return 'done'
      },
      async callChatStructured() {
        await new Promise<void>((resolve) => { resolveLLM = resolve })
        return { content: 'done' }
      },
    }

    const { result } = renderHook(() =>
      useHarness(makeSimpleFlowSpec(), { llmClient: slowLLM }),
    )

    act(() => { result.current.run() })
    expect(result.current.status).toBe('running')

    act(() => { result.current.abort() })
    resolveLLM?.()

    await waitFor(() => expect(result.current.status).toBe('error'))
  })
})

// ─── nodeStats ────────────────────────────────────────────────────────────────

describe('useHarness — nodeStats', () => {
  it('populates nodeStats after flow completes', async () => {
    const { result } = renderHook(() => useHarness(makeSimpleFlowSpec(), BASE_OPTIONS))

    act(() => { result.current.run() })
    await waitFor(() => expect(result.current.status).toBe('complete'))

    const stats = result.current.nodeStats
    expect(stats['n-input']?.status).toBe('done')
    expect(stats['n-llm']?.status).toBe('done')
    expect(stats['n-output']?.status).toBe('done')
    expect(typeof stats['n-llm']?.ms).toBe('number')
  })

  it('sets nodeStats status to running while node is executing', async () => {
    let resolveLLM!: () => void
    const pausedLLM: ILLMClient = {
      async *callChat() {
        await new Promise<void>((r) => { resolveLLM = r })
        yield 'hi'
      },
      async callChatSync() {
        await new Promise<void>((r) => { resolveLLM = r })
        return 'hi'
      },
      async callChatStructured() {
        await new Promise<void>((r) => { resolveLLM = r })
        return { content: 'hi' }
      },
    }

    const { result } = renderHook(() =>
      useHarness(makeSimpleFlowSpec(), { llmClient: pausedLLM }),
    )

    act(() => { result.current.run() })

    await waitFor(() => expect(result.current.nodeStats['n-llm']?.status).toBe('running'))

    resolveLLM()
    await waitFor(() => expect(result.current.status).toBe('complete'))
  })
})

// ─── Streaming tokens ─────────────────────────────────────────────────────────

describe('useHarness — streaming tokens', () => {
  it('accumulates streaming tokens per nodeId then clears on complete', async () => {
    const tokens = ['hel', 'lo', ' world']
    const streamLLM: ILLMClient = {
      async *callChat() { for (const t of tokens) yield t },
      async callChatSync() { return tokens.join('') },
      async callChatStructured() { return { content: tokens.join('') } },
    }

    const { result } = renderHook(() =>
      useHarness(makeSimpleFlowSpec('answer'), { llmClient: streamLLM }),
    )

    act(() => { result.current.run() })
    await waitFor(() => expect(result.current.status).toBe('complete'))

    // After completion the streaming buffer for the node is cleared
    expect(result.current.streamingTokens['n-llm']).toBeUndefined()
    // Final state contains full concatenated response
    expect(result.current.state['answer']).toBe('hello world')
  })
})

// ─── Multiple runs ────────────────────────────────────────────────────────────

describe('useHarness — multiple runs', () => {
  it('second run uses fresh FlowState and does not expose first run state', async () => {
    let callCount = 0
    const countingLLM: ILLMClient = {
      async *callChat() { callCount++; yield `run${callCount}` },
      async callChatSync() { return `run${++callCount}` },
      async callChatStructured() { return { content: `run${++callCount}` } },
    }

    const { result } = renderHook(() =>
      useHarness(makeSimpleFlowSpec('answer'), { llmClient: countingLLM }),
    )

    act(() => { result.current.run() })
    await waitFor(() => expect(result.current.status).toBe('complete'))
    const firstAnswer = result.current.state['answer']

    act(() => { result.current.run() })
    // State resets immediately on second run start
    expect(result.current.status).toBe('running')
    expect(result.current.state).toEqual({})

    await waitFor(() => expect(result.current.status).toBe('complete'))
    const secondAnswer = result.current.state['answer']

    expect(secondAnswer).not.toBe(firstAnswer)
  })
})

// ─── HITL ─────────────────────────────────────────────────────────────────────

describe('useHarness — HITL', () => {
  function makeHitlSpec() {
    return {
      spec_version: '0.2.0' as const,
      id: 'hitl-flow',
      nodes: [
        { id: 'n-input', type: 'input' as const, label: 'Start' },
        {
          id: 'n-hitl',
          type: 'hitl_breakpoint' as const,
          label: 'Review',
          prompt: 'Please review',
          resume_schema: {
            type: 'object',
            required: ['decision'],
            properties: { decision: { type: 'string' } },
          },
          on_timeout: 'raise' as const,
        },
        { id: 'n-output', type: 'output' as const, label: 'End' },
      ],
      edges: [
        { id: 'e1', type: 'direct' as const, from: 'n-input', to: 'n-hitl' },
        { id: 'e2', type: 'direct' as const, from: 'n-hitl', to: 'n-output' },
      ],
    }
  }

  it('transitions running → paused → running → complete', async () => {
    const { result } = renderHook(() => useHarness(makeHitlSpec(), BASE_OPTIONS))

    act(() => { result.current.run() })

    await waitFor(() => expect(result.current.status).toBe('paused'))
    expect(result.current.hitlPrompt).toBe('Please review')
    expect(result.current.hitlResumeSchema).toBeTruthy()

    act(() => { result.current.resume('n-hitl', { decision: 'approve' }) })
    expect(result.current.status).toBe('running')

    await waitFor(() => expect(result.current.status).toBe('complete'))
  })

  it('resume() throws fast when required field is missing', async () => {
    const { result } = renderHook(() => useHarness(makeHitlSpec(), BASE_OPTIONS))

    act(() => { result.current.run() })
    await waitFor(() => expect(result.current.status).toBe('paused'))

    expect(() => result.current.resume('n-hitl', {})).toThrow('missing required field "decision"')
    // Status remains paused — validation failed before passing to runtime
    expect(result.current.status).toBe('paused')
  })
})
