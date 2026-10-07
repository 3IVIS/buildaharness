import { FlowExecutionError } from './errors'
import { DEFAULT_REQUEST_TIMEOUT_MS, withRequestTimeout } from './request-timeout'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolCallResult, ToolDefinition } from './llm-client'

export interface OpenAICompatibleLLMClientOptions {
  apiKey: string
  baseUrl: string
  /** Used whenever a call doesn't specify options.model — the caller picks this per provider (see OPENAI_DEFAULT_MODEL / OPENROUTER_DEFAULT_MODEL in model-defaults.ts) rather than this client inferring it from baseUrl. */
  defaultModel: string
  /** OpenRouter's recommended (not required) HTTP-Referer/X-Title headers, or any other provider-specific extras — merged into every request. */
  extraHeaders?: Record<string, string>
  /** Injectable fetch — the Tauri webview's CSP blocks the global fetch to remote hosts, so the desktop app passes @tauri-apps/plugin-http's fetch here. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Longest a single wait on the endpoint may take (headers, a whole non-streamed body, or the gap between streamed chunks) before the call fails with a timeout error. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number
}

/**
 * baseUrl/defaultModel for the two OpenAI-compatible providers this app wires up out of the
 * box — exported so every call site (CLI, chat-ui browser build, Tauri desktop build)
 * constructs an OpenAICompatibleLLMClient from the exact same values instead of each surface
 * hardcoding its own copy that can silently drift. The default-model ids themselves live in
 * model-defaults.ts (with ANTHROPIC_DEFAULT_MODEL) and are re-exported here so existing
 * `@buildaharness/runtime` importers are unaffected.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export { OPENAI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL } from './model-defaults'
/**
 * OpenRouter's recommended (not required) leaderboard-attribution headers — see
 * https://openrouter.ai/docs. `HTTP-Referer` is rendered as the clickable link for
 * the app on OpenRouter's rankings, so it points at the product page rather than the
 * raw repo; `X-Title` is the display name shown there.
 */
export const OPENROUTER_EXTRA_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://myaielia.com',
  'X-Title': 'Aielia',
}

/**
 * Mirrors personal-assistant's claude-cli-prompt.ts stripJsonCodeFence (duplicated rather than
 * imported — runtime sits below personal-assistant in the dependency graph): some models routinely
 * wrap a JSON reply in a ```json ... ``` fence even under response_format: json_object, which is a
 * hint, not a hard guarantee, on several OpenRouter-routed models. Applied only to the
 * structuredOutput path, never to a plain callChat/callChatStructured-without-schema result.
 */
function stripJsonCodeFence(content: string): string {
  const trimmed = content.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return match ? match[1] : trimmed
}

function parseToolCalls(toolCalls: unknown): ToolCallResult[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined
  const results: ToolCallResult[] = []
  for (const tc of toolCalls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
    // A provider returning malformed JSON in `arguments` must never crash the turn — the tool
    // call still gets reported (with an empty input) rather than the whole response failing.
    let input: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(tc.function?.arguments ?? '{}')
      // Valid JSON that isn't an object (null, a string, an array) would crash consumers that index into input.
      input = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      input = {}
    }
    results.push({ id: tc.id ?? '', name: tc.function?.name ?? '', input })
  }
  return results
}

/**
 * Some OpenRouter-routed models (observed live with deepseek/deepseek-v4-flash-0731) don't
 * reliably populate the standard `tool_calls` field and instead leak their own native
 * function-calling serialization straight into `message.content` as plain text — an
 * `<invoke name="...">`/`<parameter name="...">` block wrapped in the model's own special
 * tokens (observed as U+FF5C fullwidth-vertical-bar-delimited tags, e.g.
 * `<｜DSML｜tool_calls>...<｜DSML｜invoke name="shell">...`). Recovers a real ToolCallResult[]
 * from that leaked block, but only when every invoked name matches a tool actually offered
 * this call — a leaked block can itself hallucinate a tool name (this one called "shell",
 * which was never registered; the real tool is "run_shell_command") and this must never
 * fabricate a call to a name the caller didn't provide. Returns undefined when nothing
 * recoverable is found, leaving agent-loop.ts's generic looksLikeUnparsedToolCall retry guard
 * as the backstop for any other/unknown leaked format.
 */
function parseLeakedToolCallSyntax(content: string, tools?: ToolDefinition[]): ToolCallResult[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const validNames = new Set(tools.map((t) => t.name))
  const invokeRe = /<｜([^｜<>]{1,32})｜invoke name="([^"]+)"[^>]*>([\s\S]*?)<\/｜\1｜invoke>/g
  const paramRe = /<｜([^｜<>]{1,32})｜parameter name="([^"]+)"([^>]*)>([\s\S]*?)<\/｜\1｜parameter>/g
  const results: ToolCallResult[] = []
  let invokeMatch: RegExpExecArray | null
  let index = 0
  while ((invokeMatch = invokeRe.exec(content)) !== null) {
    const [, , name, body] = invokeMatch
    if (!validNames.has(name)) return undefined
    const input: Record<string, unknown> = {}
    paramRe.lastIndex = 0
    let paramMatch: RegExpExecArray | null
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const raw = paramMatch[4].trim()
      // DSML's own typing attribute: string="false" marks a JSON value (number, boolean, array, object);
      // string="true" (or no attribute) is a literal string.
      let value: unknown = raw
      if (paramMatch[3].includes('string="false"')) {
        try { value = JSON.parse(raw) } catch { value = raw }
      }
      input[paramMatch[2]] = value
    }
    results.push({ id: `leaked-tool-call-${index++}`, name, input })
  }
  return results.length > 0 ? results : undefined
}

/** Strips a recovered leaked tool-call block out of the reply text before it's stored back into
 * conversation history — leaving it in would let the model imitate its own malformed syntax on
 * the next turn. Only called once parseLeakedToolCallSyntax has already found something real. */
function stripLeakedToolCallSyntax(content: string): string {
  return content.replace(/<｜[^｜<>]{1,32}｜tool_calls>[\s\S]*?<\/｜[^｜<>]{1,32}｜tool_calls>/g, '').trim()
}

/**
 * ILLMClient for any endpoint that speaks OpenAI's Chat Completions wire format —
 * OpenAI itself and OpenRouter (an OpenAI-compatible endpoint by design) both go through
 * this one implementation, parameterized by baseUrl/defaultModel/extraHeaders rather than
 * two near-duplicate classes. See anthropic-client.ts's AnthropicLLMClient for the
 * Anthropic-Messages-API-shaped equivalent.
 */
export class OpenAICompatibleLLMClient implements ILLMClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly extraHeaders: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number

  constructor({ apiKey, baseUrl, defaultModel, extraHeaders = {}, fetchImpl, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }: OpenAICompatibleLLMClientOptions) {
    this.requestTimeoutMs = requestTimeoutMs
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.defaultModel = defaultModel
    this.extraHeaders = extraHeaders
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  /** One POST to chat/completions whose wait for the response headers is bounded; the request is aborted on timeout. */
  private async post(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController()
    return withRequestTimeout(
      this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal }),
      this.requestTimeoutMs, 'openai-compatible-client', 'waiting for the model to respond', () => controller.abort(),
    )
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    }
  }

  private async errorMessage(response: Response): Promise<string> {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    return body?.error?.message ?? `HTTP ${response.status}`
  }

  /**
   * ChatMessage[] → OpenAI's message shape. Unlike Anthropic, OpenAI takes a tool result
   * inline as a 'tool'-role message (no batching into a wrapper message needed) and a
   * tool-calling assistant turn as a `tool_calls` array on the assistant message itself,
   * not content blocks.
   */
  private buildMessages(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        }
      }
      return { role: m.role, content: m.content }
    })
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    const response = await this.post({
        model: options.model ?? this.defaultModel,
        messages: this.buildMessages(messages),
        stream: true,
        // Unlike LLMClient's pass-through proxy path (which doesn't set this, making OpenAI
        // streaming usage best-effort/absent), this client controls the whole request — opting
        // in makes streaming usage reliable instead of a known gap.
        stream_options: { include_usage: true },
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      })

    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'openai-compatible-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let cachedInputTokens: number | undefined
    const reportUsage = (): void => {
      if (inputTokens !== undefined || outputTokens !== undefined) {
        options.onUsage?.({ inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, cachedInputTokens })
      }
    }

    try {
    while (true) {
      const { done, value } = await withRequestTimeout(reader.read(), this.requestTimeoutMs, 'openai-compatible-client', 'while streaming the reply')
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          reportUsage()
          return
        }
        try {
          const parsed = JSON.parse(data)
          if (typeof parsed?.usage?.prompt_tokens === 'number') inputTokens = parsed.usage.prompt_tokens
          if (typeof parsed?.usage?.completion_tokens === 'number') outputTokens = parsed.usage.completion_tokens
          if (typeof parsed?.usage?.prompt_tokens_details?.cached_tokens === 'number') cachedInputTokens = parsed.usage.prompt_tokens_details.cached_tokens
          const delta = parsed?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') yield delta
        } catch {
          // skip malformed chunks
        }
      }
    }
    } finally {
      await reader.cancel().catch(() => {})
    }
    reportUsage()
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const chunks: string[] = []
    for await (const token of this.callChat(messages, options)) chunks.push(token)
    return chunks.join('')
  }

  async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    const body: Record<string, unknown> = {
      model: options.model ?? this.defaultModel,
      messages: this.buildMessages(messages),
      stream: false,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
    }
    // Without this, a structuredOutput caller (e.g. turn-intent-classifier.ts) relies entirely on
    // the system prompt's "respond with JSON only" instruction — several OpenRouter-routed models
    // (observed live with z-ai/glm-5.2) ignore that and prose-wrap or fence the reply, which then
    // fails JSON.parse and silently falls back to the fail-safe UNKNOWN risk classification on
    // every turn. json_object (not json_schema) because OpenRouter fans out to many underlying
    // models with inconsistent json_schema support — json_object is the broadly-supported subset.
    if (options.structuredOutput) {
      body.response_format = { type: 'json_object' }
    }

    const response = await this.post(body)
    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'openai-compatible-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const json = (await withRequestTimeout(response.json(), this.requestTimeoutMs, 'openai-compatible-client', 'while reading the reply')) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    }
    const message = json.choices?.[0]?.message
    let toolCalls = parseToolCalls(message?.tool_calls)
    let content = message?.content ?? ''
    if (!toolCalls || toolCalls.length === 0) {
      const recovered = parseLeakedToolCallSyntax(content, tools)
      if (recovered) {
        toolCalls = recovered
        content = stripLeakedToolCallSyntax(content)
      }
    }
    if (json.usage && typeof json.usage.prompt_tokens === 'number' && typeof json.usage.completion_tokens === 'number') {
      options.onUsage?.({
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        cachedInputTokens: typeof json.usage.prompt_tokens_details?.cached_tokens === 'number' ? json.usage.prompt_tokens_details.cached_tokens : undefined,
      })
    }
    return { content: options.structuredOutput ? stripJsonCodeFence(content) : content, toolCalls }
  }
}
