import { FlowExecutionError } from './errors'
import { buildAnthropicMessages, parseAnthropicContentBlocks } from './anthropic-message-shape'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from './llm-client'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022'
const DEFAULT_MAX_TOKENS = 4096

export interface AnthropicLLMClientOptions {
  apiKey: string
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

  constructor({ apiKey }: AnthropicLLMClientOptions) {
    this.apiKey = apiKey
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }

  private async errorMessage(response: Response): Promise<string> {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    return body?.error?.message ?? `HTTP ${response.status}`
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages)
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        messages: anthropicMessages,
        stream: true,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    })

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
          if (typeof parsed?.message?.usage?.input_tokens === 'number') inputTokens = parsed.message.usage.input_tokens
          if (typeof parsed?.usage?.output_tokens === 'number') outputTokens = parsed.usage.output_tokens
          const delta = parsed?.delta?.text
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
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model: options.model ?? DEFAULT_MODEL,
      messages: anthropicMessages,
      stream: false,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    }

    const response = await fetch(ANTHROPIC_API_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) })
    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'anthropic-client', message: await this.errorMessage(response), cause: { status: response.status } })
    }

    const json = (await response.json()) as Record<string, unknown>
    const { content, toolCalls } = parseAnthropicContentBlocks(json.content)
    const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined
    if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
      options.onUsage?.({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens })
    }
    return { content, toolCalls }
  }
}
