import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicLLMClient } from './anthropic-client'
import { OpenAICompatibleLLMClient } from './openai-compatible-client'
import { LLMClient } from './llm-client'

// The Tauri webview's CSP blocks the global fetch to remote hosts, so the desktop app injects
// @tauri-apps/plugin-http's fetch. Each client must route EVERY request through the injected one.

function sse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const token of stream) out.push(token)
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('injected fetchImpl', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }]

  it('AnthropicLLMClient streams through fetchImpl and never touches the global fetch', async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error('global fetch must not be used'))
    vi.stubGlobal('fetch', globalFetch)
    const fetchImpl = vi.fn().mockResolvedValue(sse(['data: {"delta":{"text":"hello"}}', 'data: [DONE]']))
    const client = new AnthropicLLMClient({ apiKey: 'k', fetchImpl })

    expect(await drain(client.callChat(messages))).toEqual(['hello'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('api.anthropic.com')
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('AnthropicLLMClient structured calls go through fetchImpl', async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error('global fetch must not be used'))
    vi.stubGlobal('fetch', globalFetch)
    const fetchImpl = vi.fn().mockResolvedValue(json({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }))
    const client = new AnthropicLLMClient({ apiKey: 'k', fetchImpl })

    await client.callChatStructured(messages)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('OpenAICompatibleLLMClient streams and runs structured calls through fetchImpl', async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error('global fetch must not be used'))
    vi.stubGlobal('fetch', globalFetch)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sse(['data: {"choices":[{"delta":{"content":"foo"}}]}', 'data: [DONE]']))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    const client = new OpenAICompatibleLLMClient({ apiKey: 'k', baseUrl: 'https://openrouter.example/api/v1', defaultModel: 'm', fetchImpl })

    expect(await drain(client.callChat(messages))).toEqual(['foo'])
    await client.callChatStructured(messages)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://openrouter.example/api/v1/chat/completions')
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('LLMClient (proxy) streams and runs structured calls through fetchImpl', async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error('global fetch must not be used'))
    vi.stubGlobal('fetch', globalFetch)
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sse(['data: {"delta":{"text":"hello"}}', 'data: [DONE]']))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }))
    const client = new LLMClient({ proxyUrl: 'http://localhost:8787', authToken: 't', fetchImpl })

    expect(await drain(client.callChat(messages))).toEqual(['hello'])
    await client.callChatStructured(messages)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://localhost:8787/llm/chat')
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('falls back to the global fetch (looked up at call time) when no fetchImpl is given', async () => {
    const client = new AnthropicLLMClient({ apiKey: 'k' })
    const globalFetch = vi.fn().mockResolvedValue(sse(['data: {"delta":{"text":"x"}}', 'data: [DONE]']))
    vi.stubGlobal('fetch', globalFetch)

    expect(await drain(client.callChat(messages))).toEqual(['x'])
    expect(globalFetch).toHaveBeenCalledTimes(1)
  })
})
