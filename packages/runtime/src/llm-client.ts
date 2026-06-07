import { FlowExecutionError } from './errors'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  structuredOutput?: { schema: Record<string, unknown> }
}

export interface ILLMClient {
  callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>
  callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>
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

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') return
          try {
            const parsed = JSON.parse(data)
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
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const chunks: string[] = []
    for await (const token of this.callChat(messages, options)) {
      chunks.push(token)
    }
    return chunks.join('')
  }
}
