import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicLLMClient } from './anthropic-client'
import { FlowExecutionError } from './errors'

const API_KEY = 'test-api-key'

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
      controller.close()
    },
  })
}

function mockFetchOk(sseLines: string[]): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(makeSSEStream(sseLines), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  )
  vi.stubGlobal('fetch', mockFetch)
  return mockFetch
}

function mockFetchJson(body: Record<string, unknown>, status = 200): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  )
  vi.stubGlobal('fetch', mockFetch)
  return mockFetch
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnthropicLLMClient', () => {
  describe('callChat (streaming)', () => {
    it('yields tokens in order from an Anthropic SSE stream', async () => {
      mockFetchOk([
        'data: {"delta":{"text":"hello"}}',
        'data: {"delta":{"text":" world"}}',
        'data: [DONE]',
      ])
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) tokens.push(token)

      expect(tokens).toEqual(['hello', ' world'])
    })

    it('always sends the anthropic-dangerous-direct-browser-access header', async () => {
      const mockFetch = mockFetchOk(['data: [DONE]'])
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
        // drain
      }

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      const headers = init.headers as Record<string, string>
      expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
      expect(headers['x-api-key']).toBe(API_KEY)
      expect(headers['anthropic-version']).toBe('2023-06-01')
    })

    it('always includes max_tokens, even when none is requested (Anthropic requires it)', async () => {
      const mockFetch = mockFetchOk(['data: [DONE]'])
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
        // drain
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(typeof body.max_tokens).toBe('number')
    })

    it('reports usage from message_start/message_delta events', async () => {
      mockFetchOk([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":0}}}',
        'data: {"delta":{"text":"hi"}}',
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":7}}',
        'data: [DONE]',
      ])
      const client = new AnthropicLLMClient({ apiKey: API_KEY })
      const onUsage = vi.fn()

      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }], { onUsage })) {
        // drain
      }

      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 42, outputTokens: 7 })
    })

    it('throws FlowExecutionError with the API error message on a non-2xx response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 })
        )
      )
      const client = new AnthropicLLMClient({ apiKey: 'bad-key' })

      let caught: unknown
      try {
        for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
          // consume
        }
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(FlowExecutionError)
      expect((caught as FlowExecutionError).message).toBe('invalid x-api-key')
      expect(((caught as FlowExecutionError).cause as { status: number }).status).toBe(401)
    })
  })

  describe('callChatSync', () => {
    it('returns concatenated tokens as a single string', async () => {
      mockFetchOk([
        'data: {"delta":{"text":"Hello"}}',
        'data: {"delta":{"text":", world"}}',
        'data: [DONE]',
      ])
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      const result = await client.callChatSync([{ role: 'user', content: 'hi' }])
      expect(result).toBe('Hello, world')
    })
  })

  describe('callChatStructured', () => {
    it('parses text and tool_use blocks from the response', async () => {
      mockFetchJson({
        content: [
          { type: 'text', text: 'Let me check that file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } },
        ],
      })
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      const result = await client.callChatStructured([{ role: 'user', content: 'read notes.txt' }])

      expect(result.content).toBe('Let me check that file.')
      expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }])
    })

    it('includes tool definitions in the request body when tools are supplied', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'ok' }] })
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      await client.callChatStructured(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }],
      )

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.tools).toEqual([{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }])
    })

    it('reports usage from the response body via onUsage', async () => {
      mockFetchJson({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 25 } })
      const client = new AnthropicLLMClient({ apiKey: API_KEY })
      const onUsage = vi.fn()

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { onUsage })

      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 25 })
    })

    it('throws FlowExecutionError with the API error message on a non-2xx response', async () => {
      mockFetchJson({ error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      await expect(client.callChatStructured([{ role: 'user', content: 'hi' }])).rejects.toThrow('Overloaded')
    })

    it('falls back to the HTTP status when the error body has no message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      await expect(client.callChatStructured([{ role: 'user', content: 'hi' }])).rejects.toThrow('HTTP 500')
    })

    it('uses the default model when none is specified', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'ok' }] })
      const client = new AnthropicLLMClient({ apiKey: API_KEY })

      await client.callChatStructured([{ role: 'user', content: 'hi' }])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.model).toBe('claude-3-5-sonnet-20241022')
    })
  })
})
