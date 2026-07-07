import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LLMClient } from './llm-client'
import { FlowExecutionError } from './errors'

const PROXY_URL = 'http://localhost:8787'
const AUTH_TOKEN = 'test-auth-token'

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
}

function mockFetchOk(sseLines: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(makeSSEStream(sseLines), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
  )
}

function mockFetchError(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(null, { status })
    )
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LLMClient', () => {
  let client: LLMClient

  beforeEach(() => {
    client = new LLMClient({ proxyUrl: PROXY_URL, authToken: AUTH_TOKEN })
  })

  describe('callChat (streaming)', () => {
    it('yields tokens from Anthropic SSE stream', async () => {
      mockFetchOk([
        'data: {"delta":{"text":"hello"}}',
        'data: {"delta":{"text":" world"}}',
        'data: [DONE]',
      ])

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) {
        tokens.push(token)
      }

      expect(tokens).toEqual(['hello', ' world'])
    })

    it('yields tokens from OpenAI SSE stream', async () => {
      mockFetchOk([
        'data: {"choices":[{"delta":{"content":"foo"}}]}',
        'data: {"choices":[{"delta":{"content":"bar"}}]}',
        'data: [DONE]',
      ])

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' })) {
        tokens.push(token)
      }

      expect(tokens).toEqual(['foo', 'bar'])
    })

    it('stops at [DONE] sentinel', async () => {
      mockFetchOk([
        'data: {"delta":{"text":"only this"}}',
        'data: [DONE]',
        'data: {"delta":{"text":"never yielded"}}',
      ])

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) {
        tokens.push(token)
      }

      expect(tokens).toEqual(['only this'])
    })

    it('skips non-data lines', async () => {
      mockFetchOk([
        ': this is a comment',
        '',
        'data: {"delta":{"text":"valid"}}',
        'data: [DONE]',
      ])

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) {
        tokens.push(token)
      }

      expect(tokens).toEqual(['valid'])
    })

    it('skips malformed JSON chunks without throwing', async () => {
      mockFetchOk([
        'data: {invalid json}',
        'data: {"delta":{"text":"ok"}}',
        'data: [DONE]',
      ])

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) {
        tokens.push(token)
      }

      expect(tokens).toEqual(['ok'])
    })

    it('throws FlowExecutionError when proxy returns non-OK status', async () => {
      mockFetchError(401)

      await expect(async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow(FlowExecutionError)
    })

    it('includes status code in the FlowExecutionError cause', async () => {
      mockFetchError(500)

      let caught: unknown
      try {
        for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
          // consume
        }
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(FlowExecutionError)
      const err = caught as FlowExecutionError
      expect(err.nodeId).toBe('llm-client')
      expect((err.cause as { status: number }).status).toBe(500)
    })

    it('sends the correct request headers and body', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(makeSSEStream(['data: [DONE]']), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
      vi.stubGlobal('fetch', mockFetch)

      for await (const _ of client.callChat(
        [{ role: 'user', content: 'test' }],
        { model: 'claude-3-5-sonnet-20241022', maxTokens: 100, temperature: 0.5 }
      )) {
        // consume
      }

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${PROXY_URL}/llm/chat`)
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${AUTH_TOKEN}`)
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

      const body = JSON.parse(init.body as string)
      expect(body.model).toBe('claude-3-5-sonnet-20241022')
      expect(body.max_tokens).toBe(100)
      expect(body.temperature).toBe(0.5)
      expect(body.stream).toBe(true)
    })

    it('uses the default model when none is specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(makeSSEStream(['data: [DONE]']), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
      vi.stubGlobal('fetch', mockFetch)

      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.model).toBe('claude-3-5-sonnet-20241022')
    })
  })

  describe('callChatSync', () => {
    it('returns concatenated tokens as a single string', async () => {
      mockFetchOk([
        'data: {"delta":{"text":"Hello"}}',
        'data: {"delta":{"text":", "}}',
        'data: {"delta":{"text":"world"}}',
        'data: [DONE]',
      ])

      const result = await client.callChatSync([{ role: 'user', content: 'hi' }])
      expect(result).toBe('Hello, world')
    })

    it('returns empty string when no tokens are emitted', async () => {
      mockFetchOk(['data: [DONE]'])

      const result = await client.callChatSync([{ role: 'user', content: 'hi' }])
      expect(result).toBe('')
    })

    it('propagates FlowExecutionError from callChat', async () => {
      mockFetchError(403)

      await expect(
        client.callChatSync([{ role: 'user', content: 'hi' }])
      ).rejects.toThrow(FlowExecutionError)
    })
  })

  describe('callChat usage (onUsage)', () => {
    it('reports usage accumulated from Anthropic message_start/message_delta events', async () => {
      mockFetchOk([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":0}}}',
        'data: {"delta":{"text":"hi"}}',
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":7}}',
        'data: [DONE]',
      ])

      const onUsage = vi.fn()
      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }], { onUsage })) {
        tokens.push(token)
      }

      expect(tokens.join('')).toBe('hi')
      expect(onUsage).toHaveBeenCalledTimes(1)
      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 42, outputTokens: 7 })
    })

    it('never calls onUsage when the stream has no usage fields (e.g. an OpenAI stream without stream_options)', async () => {
      mockFetchOk([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: [DONE]',
      ])

      const onUsage = vi.fn()
      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }], { onUsage })) {
        // drain
      }

      expect(onUsage).not.toHaveBeenCalled()
    })

    it('does not throw when no onUsage callback is supplied', async () => {
      mockFetchOk([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
        'data: [DONE]',
      ])

      await expect(client.callChatSync([{ role: 'user', content: 'hi' }])).resolves.toBe('')
    })
  })

  describe('callChatStructured', () => {
    function mockFetchJson(body: Record<string, unknown>): ReturnType<typeof vi.fn> {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
      vi.stubGlobal('fetch', mockFetch)
      return mockFetch
    }

    it('parses text and tool_use blocks from an Anthropic-shaped response', async () => {
      mockFetchJson({
        content: [
          { type: 'text', text: 'Let me check that file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } },
        ],
      })

      const result = await client.callChatStructured([{ role: 'user', content: 'read notes.txt' }])

      expect(result.content).toBe('Let me check that file.')
      expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }])
    })

    it('moves a system-role message to the top-level `system` field, not the messages array', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'ok' }] })

      await client.callChatStructured([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.system).toBe('You are a helpful assistant.')
      expect(body.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true)
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    })

    it('serializes a tool-role message as a user message with a tool_result block referencing the correct tool_use_id', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'done' }] })

      await client.callChatStructured([
        { role: 'user', content: 'read notes.txt' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }] },
        { role: 'tool', content: 'hello world', toolCallId: 'toolu_1' },
      ])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      const toolResultMessage = body.messages.at(-1)
      expect(toolResultMessage).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello world' }],
      })
    })

    it('serializes an assistant tool-call message as a tool_use content block', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'done' }] })

      await client.callChatStructured([
        { role: 'user', content: 'read notes.txt' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }] },
      ])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } }],
      })
    })

    it('batches consecutive tool-role messages into a single user message with multiple tool_result blocks', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'done' }] })

      await client.callChatStructured([
        { role: 'user', content: 'read two files' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
            { id: 'toolu_2', name: 'read_file', input: { path: 'b.txt' } },
          ],
        },
        { role: 'tool', content: 'content a', toolCallId: 'toolu_1' },
        { role: 'tool', content: 'content b', toolCallId: 'toolu_2' },
      ])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.messages.at(-1)).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'content a' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'content b' },
        ],
      })
    })

    it('includes tool definitions in the request body when tools are supplied', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'ok' }] })

      await client.callChatStructured(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }],
      )

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.tools).toEqual([{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }])
    })

    it('a second call including the prior tool call and result round-trips correctly (multi-turn tool use)', async () => {
      const mockFetch = mockFetchJson({ content: [{ type: 'text', text: 'Tokyo is 9 hours ahead.' }] })

      const result = await client.callChatStructured([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What timezone is Tokyo in?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'tz.txt' } }] },
        { role: 'tool', content: 'JST (UTC+9)', toolCallId: 'toolu_1' },
      ])

      expect(result.content).toBe('Tokyo is 9 hours ahead.')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.system).toBe('You are a helpful assistant.')
      expect(body.messages).toEqual([
        { role: 'user', content: 'What timezone is Tokyo in?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'tz.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'JST (UTC+9)' }] },
      ])
    })

    it('throws FlowExecutionError when proxy returns non-OK status', async () => {
      mockFetchError(502)

      await expect(client.callChatStructured([{ role: 'user', content: 'hi' }])).rejects.toThrow(FlowExecutionError)
    })

    it('reports usage from the response body via onUsage', async () => {
      mockFetchJson({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 25 } })
      const onUsage = vi.fn()

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { onUsage })

      expect(onUsage).toHaveBeenCalledTimes(1)
      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 25 })
    })

    it('never calls onUsage when the response has no usage field', async () => {
      mockFetchJson({ content: [{ type: 'text', text: 'ok' }] })
      const onUsage = vi.fn()

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { onUsage })

      expect(onUsage).not.toHaveBeenCalled()
    })

    it('does not throw when no onUsage callback is supplied', async () => {
      mockFetchJson({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } })

      await expect(client.callChatStructured([{ role: 'user', content: 'hi' }])).resolves.toEqual({ content: 'ok', toolCalls: undefined })
    })
  })
})
