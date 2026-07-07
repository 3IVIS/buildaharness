import { FlowExecutionError } from './errors'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Set on a 'tool' message: the id of the tool_use block this is the result for (Anthropic's tool_use_id). Required to round-trip a tool result back to the API. */
  toolCallId?: string
  /** Set on an 'assistant' message that made tool calls (content may be empty): the raw calls, needed to reconstruct the tool_use content blocks when this message is replayed in a later request. */
  toolCalls?: ToolCallResult[]
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  structuredOutput?: { schema: Record<string, unknown> }
  /**
   * Called once per tool call as a backend's own internal agentic loop makes it — only
   * meaningful for a backend whose tool loop is otherwise invisible to the caller, e.g.
   * Claude Code's own loop resolving read_file/list_directory/etc. autonomously inside a
   * single `claude -p` subprocess call (see ClaudeCliLLMClient). A backend that doesn't run
   * an internal tool loop itself (the plain Anthropic API client, one call per tool round
   * trip) never calls this — the caller already sees each tool call directly and reports
   * it itself. Raw event, no human-readable summary — that's computed by the caller (see
   * personal-assistant's summarizeToolStep) so this stays a thin, dependency-free type.
   */
  onToolStep?: (event: ToolStepEvent) => void
  /**
   * Called once per call with token usage, when the backend/response actually reports it —
   * optional and best-effort, same "no-op if the caller doesn't listen" convention as
   * onToolStep, chosen over changing callChatSync/callChat's return type so every existing
   * call site and mock keeps compiling unchanged. See LLMClient's doc comments for exactly
   * when each backend can/can't supply this.
   */
  onUsage?: (usage: TokenUsage) => void
}

export interface ToolStepEvent {
  tool: string
  input: Record<string, unknown>
}

export interface ToolCallResult {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LLMStructuredResponse {
  content: string
  toolCalls?: ToolCallResult[]
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Real dollar cost, when the backend can supply one (e.g. Claude CLI's --output-format json). Absent when only token counts are known — a caller wanting a dollar figure regardless must derive one from a pricing table itself. */
  costUsd?: number
}

export interface ToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/**
 * Anthropic's Messages API takes `system` as a separate top-level string (not a
 * message with role 'system'), and expects a tool result back as a `user`
 * message containing a `tool_result` block keyed by `tool_use_id` — not a
 * message with role 'tool'. This reshapes our role-based ChatMessage[] into
 * that wire format. Consecutive 'tool' messages are batched into a single
 * user message with multiple tool_result blocks, matching how the API expects
 * the results of a multi-tool-call turn to come back in one round trip.
 */
function buildAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  const anthropicMessages: AnthropicMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }

    if (m.role === 'tool') {
      const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }
      const last = anthropicMessages[anthropicMessages.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every(b => b.type === 'tool_result')) {
        last.content.push(block)
      } else {
        anthropicMessages.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: AnthropicContentBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      anthropicMessages.push({ role: 'assistant', content: blocks })
      continue
    }

    anthropicMessages.push({ role: m.role as 'user' | 'assistant', content: m.content })
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: anthropicMessages }
}

export interface ILLMClient {
  callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>
  callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>
  callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse>
}

export class LLMClient implements ILLMClient {
  private proxyUrl: string
  private authToken: string

  constructor({ proxyUrl, authToken }: { proxyUrl: string; authToken: string }) {
    this.proxyUrl = proxyUrl
    this.authToken = authToken
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    const response = await fetch(`${this.proxyUrl}/llm/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        model: options.model ?? 'claude-3-5-sonnet-20241022',
        messages,
        stream: true,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    })

    if (!response.ok) {
      throw new FlowExecutionError({
        nodeId: 'llm-client',
        message: 'proxy error',
        cause: { status: response.status },
      })
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Anthropic's stream always includes usage (message_start's input_tokens, message_delta's
    // running output_tokens — each message_delta supersedes the last, so this is an overwrite,
    // not an accumulation). OpenAI's stream only includes it when the request opts in via
    // `stream_options: { include_usage: true }`, which this call doesn't set (to avoid changing
    // request behavior for a nice-to-have) — usage capture on this streaming path is therefore
    // best-effort, guaranteed only for Anthropic models. callChatStructured's non-streaming path
    // always gets real usage regardless of provider.
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
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') { reportUsage(); return }
          try {
            const parsed = JSON.parse(data)
            if (typeof parsed?.message?.usage?.input_tokens === 'number') inputTokens = parsed.message.usage.input_tokens
            if (typeof parsed?.usage?.output_tokens === 'number') outputTokens = parsed.usage.output_tokens
            // Anthropic
            const anthropicDelta = parsed?.delta?.text
            if (typeof anthropicDelta === 'string') { yield anthropicDelta; continue }
            // OpenAI
            const openaiDelta = parsed?.choices?.[0]?.delta?.content
            if (typeof openaiDelta === 'string') yield openaiDelta
          } catch {
            // skip malformed chunks
          }
        }
      }
    }
    reportUsage()
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const chunks: string[] = []
    for await (const token of this.callChat(messages, options)) {
      chunks.push(token)
    }
    return chunks.join('')
  }

  async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model: options.model ?? 'claude-3-5-sonnet-20241022',
      messages: anthropicMessages,
      stream: false,
      ...(system ? { system } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
    }
    const response = await fetch(`${this.proxyUrl}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.authToken}` },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new FlowExecutionError({ nodeId: 'llm-client', message: 'proxy error', cause: { status: response.status } })
    }
    const json = await response.json() as Record<string, unknown>
    // Parse Anthropic response format
    const contentParts: string[] = []
    const toolCalls: ToolCallResult[] = []
    if (Array.isArray(json.content)) {
      for (const block of json.content as Array<{type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>}>) {
        if (block.type === 'text' && block.text) contentParts.push(block.text)
        else if (block.type === 'tool_use' && block.id && block.name) {
          toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} })
        }
      }
    }
    // Anthropic's non-streaming response always includes usage — reliable regardless of
    // provider, unlike callChat's best-effort streaming capture above.
    const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined
    if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
      options.onUsage?.({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens })
    }
    return { content: contentParts.join(''), toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
  }
}
