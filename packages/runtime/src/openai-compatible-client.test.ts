import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  OpenAICompatibleLLMClient,
  OPENAI_BASE_URL as REAL_OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_BASE_URL as REAL_OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_EXTRA_HEADERS,
} from './openai-compatible-client'
import { FlowExecutionError } from './errors'

const API_KEY = 'test-api-key'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

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

describe('OpenAICompatibleLLMClient', () => {
  describe('callChat (streaming)', () => {
    it('yields tokens in order', async () => {
      mockFetchOk([
        'data: {"choices":[{"delta":{"content":"foo"}}]}',
        'data: {"choices":[{"delta":{"content":"bar"}}]}',
        'data: [DONE]',
      ])
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) tokens.push(token)

      expect(tokens).toEqual(['foo', 'bar'])
    })

    it('stops at the [DONE] sentinel', async () => {
      mockFetchOk([
        'data: {"choices":[{"delta":{"content":"only this"}}]}',
        'data: [DONE]',
        'data: {"choices":[{"delta":{"content":"never yielded"}}]}',
      ])
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const tokens: string[] = []
      for await (const token of client.callChat([{ role: 'user', content: 'hi' }])) tokens.push(token)

      expect(tokens).toEqual(['only this'])
    })

    it('requests stream_options.include_usage and reports usage from the stream', async () => {
      const mockFetch = mockFetchOk([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
        'data: [DONE]',
      ])
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })
      const onUsage = vi.fn()

      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }], { onUsage })) {
        // drain
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.stream_options).toEqual({ include_usage: true })
      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 3 })
    })

    it('throws FlowExecutionError with the API error message on a non-2xx response', async () => {
      mockFetchJson({ error: { message: 'Invalid API key' } }, 401)
      const client = new OpenAICompatibleLLMClient({ apiKey: 'bad-key', baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      let caught: unknown
      try {
        for await (const _ of client.callChat([{ role: 'user', content: 'hi' }])) {
          // consume
        }
      } catch (e) {
        caught = e
      }

      expect(caught).toBeInstanceOf(FlowExecutionError)
      expect((caught as FlowExecutionError).message).toBe('Invalid API key')
      expect(((caught as FlowExecutionError).cause as { status: number }).status).toBe(401)
    })
  })

  describe('callChatSync', () => {
    it('returns concatenated tokens as a single string', async () => {
      mockFetchOk([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":", world"}}]}',
        'data: [DONE]',
      ])
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const result = await client.callChatSync([{ role: 'user', content: 'hi' }])
      expect(result).toBe('Hello, world')
    })
  })

  describe('callChatStructured', () => {
    it('parses text content from a plain response', async () => {
      mockFetchJson({ choices: [{ message: { content: 'Hello there', role: 'assistant' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const result = await client.callChatStructured([{ role: 'user', content: 'hi' }])

      expect(result.content).toBe('Hello there')
      expect(result.toolCalls).toBeUndefined()
    })

    it('parses tool_calls from the response into ToolCallResult[]', async () => {
      mockFetchJson({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } },
            ],
          },
        }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const result = await client.callChatStructured([{ role: 'user', content: 'read notes.txt' }])

      expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'notes.txt' } }])
    })

    it('degrades to an empty input object instead of throwing on malformed tool_call arguments JSON', async () => {
      mockFetchJson({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{not valid json' } }],
          },
        }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const result = await client.callChatStructured([{ role: 'user', content: 'hi' }])

      expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: {} }])
    })

    it('sends a tool-role message inline with tool_call_id, not batched', async () => {
      const mockFetch = mockFetchJson({ choices: [{ message: { content: 'done' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      await client.callChatStructured([
        { role: 'user', content: 'read notes.txt' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'notes.txt' } }] },
        { role: 'tool', content: 'file contents', toolCallId: 'call_1' },
      ])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }],
      })
      expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })
    })

    it('includes tool definitions in OpenAI function-calling shape', async () => {
      const mockFetch = mockFetchJson({ choices: [{ message: { content: 'ok' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      await client.callChatStructured(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }],
      )

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.tools).toEqual([
        { type: 'function', function: { name: 'read_file', description: 'reads a file', parameters: { type: 'object' } } },
      ])
    })

    it('reports usage via onUsage', async () => {
      mockFetchJson({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })
      const onUsage = vi.fn()

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { onUsage })

      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 50, outputTokens: 10 })
    })

    it('throws FlowExecutionError with the API error message on a non-2xx response', async () => {
      mockFetchJson({ error: { message: 'rate limit exceeded' } }, 429)
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      await expect(client.callChatStructured([{ role: 'user', content: 'hi' }])).rejects.toThrow('rate limit exceeded')
    })
  })

  describe('OpenAI vs OpenRouter construction', () => {
    it('only differ in baseUrl, extraHeaders, and default model — not client behavior', async () => {
      const openaiFetch = mockFetchJson({ choices: [{ message: { content: 'ok' } }] })
      const openaiClient = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: REAL_OPENAI_BASE_URL, defaultModel: OPENAI_DEFAULT_MODEL })
      await openaiClient.callChatStructured([{ role: 'user', content: 'hi' }])
      const [openaiUrl, openaiInit] = openaiFetch.mock.calls[0] as [string, RequestInit]
      expect(openaiUrl).toBe(`${REAL_OPENAI_BASE_URL}/chat/completions`)
      expect(JSON.parse(openaiInit.body as string).model).toBe(OPENAI_DEFAULT_MODEL)
      expect((openaiInit.headers as Record<string, string>)['HTTP-Referer']).toBeUndefined()

      const openrouterFetch = mockFetchJson({ choices: [{ message: { content: 'ok' } }] })
      const openrouterClient = new OpenAICompatibleLLMClient({
        apiKey: API_KEY,
        baseUrl: REAL_OPENROUTER_BASE_URL,
        defaultModel: OPENROUTER_DEFAULT_MODEL,
        extraHeaders: OPENROUTER_EXTRA_HEADERS,
      })
      await openrouterClient.callChatStructured([{ role: 'user', content: 'hi' }])
      const [openrouterUrl, openrouterInit] = openrouterFetch.mock.calls[0] as [string, RequestInit]
      expect(openrouterUrl).toBe(`${REAL_OPENROUTER_BASE_URL}/chat/completions`)
      expect(JSON.parse(openrouterInit.body as string).model).toBe(OPENROUTER_DEFAULT_MODEL)
      expect((openrouterInit.headers as Record<string, string>)['HTTP-Referer']).toBe(OPENROUTER_EXTRA_HEADERS['HTTP-Referer'])

      // Same request shape otherwise (messages array built identically).
      expect(JSON.parse(openaiInit.body as string).messages).toEqual(JSON.parse(openrouterInit.body as string).messages)
    })
  })
})
