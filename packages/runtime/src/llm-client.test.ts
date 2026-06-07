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
})
