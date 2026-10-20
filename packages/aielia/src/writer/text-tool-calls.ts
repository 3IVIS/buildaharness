import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { parseModelJson } from '../model-json.js'

/**
 * Tool use for a backend that cannot take tool definitions itself (the local `claude -p` client runs its own tool loop and hands back only text).
 * The tools are described in the system text, the conversation so far is written out as one prompt, and the model asks for lookups with a JSON
 * object, which is turned back into the same tool calls an API backend returns. The caller's loop then runs the lookups as for any backend.
 * Pure: no node or DOM imports.
 */

/** Whether the client takes tool definitions and returns tool calls itself (every API backend does; `claude -p` does not). */
export function hasNativeToolCalls(llm: ILLMClient): boolean {
  return llm.nativeToolCalls !== false
}

function protocol(tools: readonly ToolDefinition[]): string {
  return (
    '\n\nTOOL PROTOCOL. You have these tools: ' + tools.map((t) => `${t.name} ${JSON.stringify(t.input_schema.properties)} (${t.description ?? ''})`).join(' | ') +
    '. To use tools, reply with ONLY this JSON object and nothing else: {"tool_calls":[{"name":"search","input":{"pattern":"..."}}]}. You may list several independent calls in one reply (do so to save turns). ' +
    'Tool results come back in the next message. When you are done, reply with the final JSON array only (no tool_calls).'
  )
}

function transcript(messages: readonly ChatMessage[]): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant') return `ASSISTANT: ${m.toolCalls?.length ? JSON.stringify({ tool_calls: m.toolCalls.map((c) => ({ name: c.name, input: c.input })) }) : m.content}`
      if (m.role === 'tool') return `TOOL RESULT:\n${m.content}`
      return `USER:\n${m.content}`
    })
    .join('\n\n')
}

/** The model sometimes writes its own XML call form (`<invoke name="search"><parameter name="pattern">..</parameter></invoke>`) instead of the JSON asked for. */
function xmlCalls(reply: string): { name: string; input: Record<string, unknown> }[] {
  return [...reply.matchAll(/<invoke name="(\w+)">([\s\S]*?)<\/invoke>/g)].map((m) => ({
    name: m[1],
    input: Object.fromEntries([...m[2].matchAll(/<parameter name="(\w+)">([\s\S]*?)<\/parameter>/g)].map((p) => [p[1], p[2].trim()])),
  }))
}

/** One model turn with tools, over plain text. Returns tool calls when the reply asks for lookups, else the reply as the content. */
export async function callWithTextTools(llm: ILLMClient, messages: ChatMessage[], tools: ToolDefinition[], options: ChatOptions): Promise<LLMStructuredResponse> {
  const system = messages.find((m) => m.role === 'system')?.content ?? ''
  const reply = await llm.callChatSync([{ role: 'system', content: system + protocol(tools) }, { role: 'user', content: transcript(messages) + '\n\nASSISTANT:' }], options)
  let parsed: unknown
  try { parsed = parseModelJson(reply) } catch { parsed = undefined }
  let list = (parsed as { tool_calls?: { name?: unknown; input?: Record<string, unknown> }[] } | undefined)?.tool_calls
  if (!Array.isArray(list)) { const x = xmlCalls(reply); list = x.length > 0 ? x : undefined }
  if (Array.isArray(list) && list.length > 0) {
    const turn = messages.length
    return { content: '', toolCalls: list.map((c, i) => ({ id: `t${turn}_${i}`, name: String(c.name), input: c.input ?? {} })) }
  }
  return { content: reply }
}
