import { FlowExecutionError } from './errors'
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STRUCTURED_REQUEST_TIMEOUT_MS, withRequestTimeout } from './request-timeout'
import { buildAnthropicMessages, parseAnthropicContentBlocks } from './anthropic-message-shape'
import { ANTHROPIC_DEFAULT_MODEL } from './model-defaults'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from './llm-client'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

export interface AnthropicLLMClientOptions {
  apiKey: string
  /** Injectable fetch — the Tauri webview's CSP blocks the global fetch to remote hosts, so the desktop app passes @tauri-apps/plugin-http's fetch here. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Longest a single wait on the API may take (headers, a whole non-streamed body, or the gap between streamed chunks) before the call fails with a timeout error. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number
  /** The same bound for a structuredOutput call (the small JSON side calls). Defaults to DEFAULT_STRUCTURED_REQUEST_TIMEOUT_MS. A per-call `ChatOptions.timeoutMs` overrides both. */
  structuredRequestTimeoutMs?: number
}

/**
 * Direct-to-Anthropic ILLMClient — no self-hosted proxy involved. Used when a user pastes
 * their own Anthropic API key into Settings (config.llmBackend === 'anthropic') instead of
 * deploying packages/proxy. Reuses LLMClient's Anthropic message-shaping and response
 * parsing (anthropic-message-shape.ts) so the two Anthropic-shaped clients can't drift.
 *
 * Unlike LLMClient (which lets the proxy's own request body dictate `max_tokens`), the
 * Messages API rejects a request with no `max_tokens` at all, so this client always sends
 * one (options.maxTokens, or a default).
 *
 * `anthropic-dangerous-direct-browser-access: true` is Anthropic's documented opt-in for a
 * plain `fetch()` from a browser tab (otherwise CORS-rejected) — sent unconditionally since
 * it's harmless from Node/Tauri too, keeping this one implementation instead of a
 * browser-only branch.
 */
export class AnthropicLLMClient implements ILLMClient {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly structuredRequestTimeoutMs: number

  constructor({ apiKey, fetchImpl, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, structuredRequestTimeoutMs = DEFAULT_STRUCTURED_REQUEST_TIMEOUT_MS }: AnthropicLLMClientOptions) {
    this.apiKey = apiKey
    this.requestTimeoutMs = requestTimeoutMs
    this.structuredRequestTimeoutMs = structuredRequestTimeoutMs
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }

  /** One POST to the Messages API whose wait for the response headers is bounded; the request is aborted on timeout. */
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    return withRequestTimeout(
      this.fetchImpl(ANTHROPIC_API_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal }),
      timeoutMs, 'anthropic-client', 'waiting for the model to respond', () => controller.abort(),
    )
  }

  private async errorMessage(response: Response): Promise<string> {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    return body?.error?.message ?? `HTTP ${response.status}`
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages)
    const response = await this.post(
      {
        model: options.model ?? ANTHROPIC_DEFAULT_MODEL,
        messages: anthropicMessages,
        stream: true,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
      options.timeoutMs ?? this.requestTimeoutMs,
    )

    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'anthropic-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Anthropic's stream always includes usage (message_start's input_tokens, message_delta's
    // running output_tokens — each message_delta supersedes the last, so this is an overwrite,
    // not an accumulation) — see LLMClient.callChat's matching comment for the shared reasoning.
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    const reportUsage = (): void => {
      if (inputTokens !== undefined || outputTokens !== undefined) {
        options.onUsage?.({ inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 })
      }
    }

    try {
    while (true) {
      const { done, value } = await withRequestTimeout(reader.read(), options.timeoutMs ?? this.requestTimeoutMs, 'anthropic-client', 'while streaming the reply')
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
          if (typeof parsed?.message?.usage?.input_tokens === 'number') inputTokens = parsed.message.usage.input_tokens
          if (typeof parsed?.usage?.output_tokens === 'number') outputTokens = parsed.usage.output_tokens
          const delta = parsed?.delta?.text
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
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model: options.model ?? ANTHROPIC_DEFAULT_MODEL,
      messages: anthropicMessages,
      stream: false,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    }

    // A structuredOutput call is one of the small JSON side calls: it gets the shorter bound unless the caller sets its own.
    const timeoutMs = options.timeoutMs ?? (options.structuredOutput ? this.structuredRequestTimeoutMs : this.requestTimeoutMs)
    const response = await this.post(body, timeoutMs)
    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'anthropic-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const json = (await withRequestTimeout(response.json(), timeoutMs, 'anthropic-client', 'while reading the reply')) as Record<string, unknown>
    const { content, toolCalls } = parseAnthropicContentBlocks(json.content)
    const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined
    if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
      options.onUsage?.({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens })
    }
    return { content, toolCalls }
  }
}
