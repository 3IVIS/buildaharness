import { FlowExecutionError } from './errors'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolCallResult, ToolDefinition } from './llm-client'

export interface OpenAICompatibleLLMClientOptions {
  apiKey: string
  baseUrl: string
  /** Used whenever a call doesn't specify options.model — the caller picks this per provider (e.g. 'gpt-4o-mini' for OpenAI, 'anthropic/claude-sonnet-5' for OpenRouter) rather than this client inferring it from baseUrl. */
  defaultModel: string
  /** OpenRouter's recommended (not required) HTTP-Referer/X-Title headers, or any other provider-specific extras — merged into every request. */
  extraHeaders?: Record<string, string>
}

/**
 * baseUrl/defaultModel for the two OpenAI-compatible providers this app wires up out of the
 * box — exported so every call site (CLI, chat-ui browser build, Tauri desktop build)
 * constructs an OpenAICompatibleLLMClient from the exact same values instead of each surface
 * hardcoding its own copy that can silently drift.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
// Verified live against OpenRouter's /models endpoint — OpenRouter's slugs for older dated
// Claude snapshots (e.g. 'anthropic/claude-3.5-sonnet') get removed as models are
// decommissioned, so this needs occasional re-verification, not a "set once" constant.
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-5'
/** OpenRouter's recommended (not required) leaderboard-attribution headers — see https://openrouter.ai/docs. */
export const OPENROUTER_EXTRA_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://github.com/buildaharness/buildaharness',
  'X-Title': 'Build A Harness',
}

function parseToolCalls(toolCalls: unknown): ToolCallResult[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined
  const results: ToolCallResult[] = []
  for (const tc of toolCalls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
    // A provider returning malformed JSON in `arguments` must never crash the turn — the tool
    // call still gets reported (with an empty input) rather than the whole response failing.
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(tc.function?.arguments ?? '{}')
    } catch {
      input = {}
    }
    results.push({ id: tc.id ?? '', name: tc.function?.name ?? '', input })
  }
  return results
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

  constructor({ apiKey, baseUrl, defaultModel, extraHeaders = {} }: OpenAICompatibleLLMClientOptions) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.defaultModel = defaultModel
    this.extraHeaders = extraHeaders
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: options.model ?? this.defaultModel,
        messages: this.buildMessages(messages),
        stream: true,
        // Unlike LLMClient's pass-through proxy path (which doesn't set this, making OpenAI
        // streaming usage best-effort/absent), this client controls the whole request — opting
        // in makes streaming usage reliable instead of a known gap.
        stream_options: { include_usage: true },
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    })

    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'openai-compatible-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    const reportUsage = (): void => {
      if (inputTokens !== undefined || outputTokens !== undefined) {
        options.onUsage?.({ inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 })
      }
    }

    while (true) {
      const { done, value } = await reader.read()
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
          const delta = parsed?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') yield delta
        } catch {
          // skip malformed chunks
        }
      }
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) })
    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'openai-compatible-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const message = json.choices?.[0]?.message
    const toolCalls = parseToolCalls(message?.tool_calls)
    if (json.usage && typeof json.usage.prompt_tokens === 'number' && typeof json.usage.completion_tokens === 'number') {
      options.onUsage?.({ inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens })
    }
    return { content: message?.content ?? '', toolCalls }
  }
}
