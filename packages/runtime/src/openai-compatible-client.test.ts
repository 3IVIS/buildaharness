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

    it('reports cachedInputTokens from the stream when prompt_tokens_details.cached_tokens is present', async () => {
      mockFetchOk([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":500,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":420}}}',
        'data: [DONE]',
      ])
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })
      const onUsage = vi.fn()

      for await (const _ of client.callChat([{ role: 'user', content: 'hi' }], { onUsage })) {
        // drain
      }

      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 500, outputTokens: 3, cachedInputTokens: 420 })
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

    it('degrades to an empty input object when tool_call arguments parse to a non-object', async () => {
      mockFetchJson({
        choices: [{ message: { content: null, tool_calls: [
          { id: 'a', type: 'function', function: { name: 'x', arguments: 'null' } },
          { id: 'b', type: 'function', function: { name: 'y', arguments: '[1]' } },
        ] } }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })
      const result = await client.callChatStructured([{ role: 'user', content: 'hi' }])
      expect(result.toolCalls?.map((c) => c.input)).toEqual([{}, {}])
    })

    it('recovers a real tool call from a leaked DSML-style pseudo-tool-call block when the invoked name matches a registered tool', async () => {
      mockFetchJson({
        choices: [{
          message: {
            content:
              'Before pushing, let me check the remotes:\n\n' +
              '<｜DSML｜tool_calls>\n' +
              '<｜DSML｜invoke name="run_shell_command">\n' +
              '<｜DSML｜parameter name="command">git remote -v</｜DSML｜parameter>\n' +
              '<｜DSML｜parameter name="cwd">/repo</｜DSML｜parameter>\n' +
              '</｜DSML｜invoke>\n' +
              '</｜DSML｜tool_calls>',
            tool_calls: undefined,
          },
        }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'deepseek/deepseek-v4-flash-0731' })

      const result = await client.callChatStructured(
        [{ role: 'user', content: 'push my commits' }],
        [{ name: 'run_shell_command', description: 'runs a shell command', input_schema: { type: 'object' } }],
      )

      expect(result.toolCalls).toEqual([
        { id: 'leaked-tool-call-0', name: 'run_shell_command', input: { command: 'git remote -v', cwd: '/repo' } },
      ])
      expect(result.content).not.toContain('｜DSML｜')
      expect(result.content).toContain('Before pushing, let me check the remotes:')
    })

    it('recovers the exact deepseek-v4-flash DSML sample seen in benchmark scenarios 02/03 (string="true" parameter, no leading prose)', async () => {
      const command = 'git diff --stat && echo "---" && git diff'
      mockFetchJson({
        choices: [{
          message: {
            content:
              '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="run_shell_command">\n' +
              `<｜DSML｜parameter name="command" string="true">${command}</｜DSML｜parameter>\n` +
              '</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
          },
        }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'deepseek/deepseek-v4-flash' })

      const result = await client.callChatStructured(
        [{ role: 'user', content: 'review my changes' }],
        [{ name: 'run_shell_command', description: 'runs a shell command', input_schema: { type: 'object' } }],
      )

      expect(result.toolCalls).toEqual([{ id: 'leaked-tool-call-0', name: 'run_shell_command', input: { command } }])
      expect(result.content).toBe('')
    })

    it('recovers several DSML invokes and types parameters by their string="true"/"false" attribute (JSON values for "false")', async () => {
      mockFetchJson({
        choices: [{
          message: {
            content:
              '<｜DSML｜tool_calls>\n' +
              '<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">a.py</｜DSML｜parameter>\n</｜DSML｜invoke>\n' +
              '<｜DSML｜invoke name="run_shell_command">\n' +
              '<｜DSML｜parameter name="command" string="true">ls 42</｜DSML｜parameter>\n' +
              '<｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>\n' +
              '<｜DSML｜parameter name="recursive" string="false">true</｜DSML｜parameter>\n' +
              '<｜DSML｜parameter name="files" string="false">["a","b"]</｜DSML｜parameter>\n' +
              '<｜DSML｜parameter name="broken" string="false">not json</｜DSML｜parameter>\n' +
              '</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
          },
        }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'deepseek/deepseek-v4-flash' })

      const result = await client.callChatStructured(
        [{ role: 'user', content: 'x' }],
        [
          { name: 'read_file', description: 'reads', input_schema: { type: 'object' } },
          { name: 'run_shell_command', description: 'runs', input_schema: { type: 'object' } },
        ],
      )

      expect(result.toolCalls).toEqual([
        { id: 'leaked-tool-call-0', name: 'read_file', input: { path: 'a.py' } },
        {
          id: 'leaked-tool-call-1',
          name: 'run_shell_command',
          input: { command: 'ls 42', timeout: 30, recursive: true, files: ['a', 'b'], broken: 'not json' },
        },
      ])
    })

    it('never fabricates a tool call from a leaked block whose invoked name is not a registered tool', async () => {
      mockFetchJson({
        choices: [{
          message: {
            content: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="shell">\n<｜DSML｜parameter name="command">git remote -v</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
          },
        }],
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'deepseek/deepseek-v4-flash-0731' })

      const result = await client.callChatStructured(
        [{ role: 'user', content: 'push my commits' }],
        [{ name: 'run_shell_command', description: 'runs a shell command', input_schema: { type: 'object' } }],
      )

      expect(result.toolCalls).toBeUndefined()
      // Left intact (not stripped) precisely because nothing was recovered — agent-loop.ts's
      // generic looksLikeUnparsedToolCall backstop is what's relied on to catch this case.
      expect(result.content).toContain('｜DSML｜')
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

    it('reports cachedInputTokens via onUsage when the response includes prompt_tokens_details.cached_tokens', async () => {
      mockFetchJson({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 380 } },
      })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })
      const onUsage = vi.fn()

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { onUsage })

      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 500, outputTokens: 10, cachedInputTokens: 380 })
    })

    it('omits cachedInputTokens when the response has no prompt_tokens_details (provider/model doesn\'t report cache stats)', async () => {
      mockFetchJson({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })
      const onUsage = vi.fn()

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { onUsage })

      expect(onUsage.mock.calls[0][0].cachedInputTokens).toBeUndefined()
    })

    it('sends response_format: json_object when options.structuredOutput is set', async () => {
      const mockFetch = mockFetchJson({ choices: [{ message: { content: '{"ok":true}' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { structuredOutput: { schema: { type: 'object' } } })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.response_format).toEqual({ type: 'json_object' })
    })

    it('omits response_format when options.structuredOutput is not set', async () => {
      const mockFetch = mockFetchJson({ choices: [{ message: { content: 'Hello there' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      await client.callChatStructured([{ role: 'user', content: 'hi' }])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
      expect(body.response_format).toBeUndefined()
    })

    it('strips a markdown code fence from a structuredOutput reply', async () => {
      mockFetchJson({ choices: [{ message: { content: '```json\n{"riskLevel":"LOW"}\n```' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const result = await client.callChatStructured([{ role: 'user', content: 'hi' }], undefined, { structuredOutput: { schema: { type: 'object' } } })

      expect(result.content).toBe('{"riskLevel":"LOW"}')
    })

    it('never fence-strips a plain (non-structuredOutput) reply', async () => {
      mockFetchJson({ choices: [{ message: { content: '```json\n{"riskLevel":"LOW"}\n```' } }] })
      const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'gpt-4o-mini' })

      const result = await client.callChatStructured([{ role: 'user', content: 'hi' }])

      expect(result.content).toBe('```json\n{"riskLevel":"LOW"}\n```')
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

describe('request timeout (a stalled request must not freeze a turn)', () => {
  const makeClient = (fetchImpl: typeof fetch, requestTimeoutMs = 50) =>
    new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'm', fetchImpl, requestTimeoutMs })
  const user = [{ role: 'user' as const, content: 'hi' }]

  it('rejects a structured call whose fetch never resolves', async () => {
    const client = makeClient((() => new Promise(() => {})) as unknown as typeof fetch)
    await expect(client.callChatStructured(user)).rejects.toThrow(/timed out/)
  })

  it('rejects a structured call whose body never finishes', async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const client = makeClient((async () => stalled) as unknown as typeof fetch)
    await expect(client.callChatStructured(user)).rejects.toThrow(/timed out/)
  })

  it('rejects a streamed reply that stalls after its first chunk, and the timeout is a FlowExecutionError', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n'))
        // never closes
      },
    })
    const client = makeClient((async () => new Response(stream, { status: 200 })) as unknown as typeof fetch)
    const seen: string[] = []
    const run = (async () => { for await (const t of client.callChat(user)) seen.push(t) })()
    await expect(run).rejects.toBeInstanceOf(FlowExecutionError)
    expect(seen).toEqual(['par'])
  })

  it('does not fire for a request that answers in time', async () => {
    const body = { choices: [{ message: { content: 'ok' } }] }
    const client = makeClient((async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch)
    await expect(client.callChatStructured(user)).resolves.toMatchObject({ content: 'ok' })
  })
})

describe('shorter bound for structured side calls (a stalled classifier or audit must not hold a turn for minutes)', () => {
  const user = [{ role: 'user' as const, content: 'hi' }]
  const never = (() => new Promise(() => {})) as unknown as typeof fetch
  const answers = (afterMs: number): typeof fetch => (async () => {
    await new Promise((r) => setTimeout(r, afterMs))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
  }) as unknown as typeof fetch
  const make = (fetchImpl: typeof fetch, extra: Record<string, number> = {}) =>
    new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'm', fetchImpl, requestTimeoutMs: 600, structuredRequestTimeoutMs: 40, ...extra })

  it('gives a structuredOutput call the short bound', async () => {
    const t0 = Date.now()
    await expect(make(never).callChatStructured(user, undefined, { structuredOutput: { schema: {} } })).rejects.toThrow(/timed out/)
    expect(Date.now() - t0).toBeLessThan(400)
  })

  it('keeps the long bound for a call without structuredOutput, which may legitimately take longer', async () => {
    await expect(make(answers(150)).callChatStructured(user)).resolves.toMatchObject({ content: 'ok' })
  })

  it('lets a call override its own bound', async () => {
    await expect(make(answers(150)).callChatStructured(user, undefined, { structuredOutput: { schema: {} }, timeoutMs: 600 })).resolves.toMatchObject({ content: 'ok' })
    await expect(make(never).callChatStructured(user, undefined, { timeoutMs: 30 })).rejects.toThrow(/timed out/)
  })

  it('defaults a structured bound of 120 s and a main bound of 300 s', async () => {
    const client = new OpenAICompatibleLLMClient({ apiKey: API_KEY, baseUrl: OPENAI_BASE_URL, defaultModel: 'm', fetchImpl: never }) as unknown as { requestTimeoutMs: number; structuredRequestTimeoutMs: number }
    expect(client.requestTimeoutMs).toBe(300_000)
    expect(client.structuredRequestTimeoutMs).toBe(120_000)
  })
})
