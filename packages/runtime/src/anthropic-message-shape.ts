import type { ChatMessage, ToolCallResult } from './llm-client'

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export interface AnthropicMessage {
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
 *
 * Shared by LLMClient (the self-hosted-proxy client) and AnthropicLLMClient
 * (direct-to-API) so the two Anthropic-shaped clients can't silently drift apart.
 */
export function buildAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
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

/**
 * Parses an Anthropic Messages API response's `content` array (text + tool_use blocks) into
 * plain reply text plus structured tool calls. Shared by LLMClient's proxy path and
 * AnthropicLLMClient's direct path — both receive the identical response shape.
 */
export function parseAnthropicContentBlocks(content: unknown): { content: string; toolCalls?: ToolCallResult[] } {
  const contentParts: string[] = []
  const toolCalls: ToolCallResult[] = []
  if (Array.isArray(content)) {
    for (const block of content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
      if (block.type === 'text' && block.text) contentParts.push(block.text)
      else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} })
      }
    }
  }
  return { content: contentParts.join(''), toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}
