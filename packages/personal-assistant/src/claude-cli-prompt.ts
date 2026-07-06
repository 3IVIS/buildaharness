import type { ChatMessage } from '@buildaharness/runtime'
import type { PendingActionRecord } from './file-tools.js'

/**
 * Synthetic tool name a claude-cli-backed ILLMClient uses to signal "an action was already
 * staged by the file-tools MCP server during this call" — distinct from `write_file`/
 * `run_shell_command` so assistant.ts's tool loop adopts the already-staged id instead of
 * staging a second, redundant pending action. Shared across every backend that wires that
 * MCP server into a `claude -p` call (claude-cli-llm-client.ts today; a Tauri desktop
 * bridge tomorrow) so assistant.ts's `call.name === '__staged_action'` check has exactly
 * one producer to stay in sync with.
 */
export const ALREADY_STAGED_ACTION_TOOL = '__staged_action'

/** Reduces a staged record down to the synthetic __staged_action tool call's input shape. Shared for the same reason ALREADY_STAGED_ACTION_TOOL above is. */
export function stagedActionInput(record: PendingActionRecord): { id: string; kind: 'write' | 'shell' } & Record<string, unknown> {
  if (record.kind === 'write') return { id: record.id, kind: 'write', path: record.path, content: record.content }
  return { id: record.id, kind: 'shell', command: record.command, cwd: record.cwd }
}

/**
 * Converts a ChatMessage[] transcript into the `--system-prompt`/trailing-prompt-argument
 * pair a `claude -p` invocation expects. Pure and environment-agnostic (no node:child_process
 * import) so it can be shared by every backend that shells out to the Claude CLI — today
 * that's claude-cli-llm-client.ts (spawns `claude` directly via node:child_process, used by
 * the CLI front end) and chat-ui's TauriClaudeCliLLMClient (invokes a Tauri Rust command that
 * spawns `claude`, used by the desktop front end) — without the two drifting apart.
 */
export function buildClaudePrompt(messages: ChatMessage[]): { systemPrompt: string; prompt: string } {
  const systemParts: string[] = []
  const turns: string[] = []
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content)
    else if (m.role === 'assistant') turns.push(`Assistant: ${m.content}`)
    else turns.push(m.content)
  }
  // The Anthropic API rejects a system prompt that's whitespace-only ("text content blocks
  // must contain non-whitespace text") — a bare ' ' fallback would 400 on every call. Every
  // real caller today always supplies a system message (assistant.ts's runToolLoop), so this
  // fallback is a defensive backstop, not a normal path — but it must still be valid.
  return { systemPrompt: systemParts.join('\n\n') || 'You are a helpful assistant.', prompt: turns.join('\n\n') }
}

/**
 * Parses `claude --output-format json`'s stdout into the reply text, falling back to the raw
 * stdout if it isn't valid JSON (e.g. the CLI printed a plain-text error before reaching
 * --output-format handling). Shared for the same reason buildClaudePrompt above is.
 */
export function parseClaudeCliOutput(stdout: string): string {
  try {
    const data = JSON.parse(stdout.trim()) as { result?: string; content?: string }
    return data.result ?? data.content ?? stdout.trim()
  } catch {
    return stdout.trim()
  }
}
