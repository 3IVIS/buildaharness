import type { ChatMessage, TokenUsage } from '@buildaharness/runtime'
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
 *
 * Every call to `claude -p` is a fresh, stateless subprocess (`--no-session-persistence`) —
 * there is no real prior turn from the underlying API's point of view, only whatever text we
 * hand it in this one prompt argument. When there's more than one prior turn to carry, the
 * history is explicitly framed as a labeled, delimited block ("verbatim conversation so far
 * ... never doubt, deny, or second-guess it") clearly separated from the current message,
 * rather than just interleaved as bare lines — found via live testing (conv150/conv166's
 * re-probe) that a flat, unframed interleaving occasionally led the model to treat its own
 * prior "Assistant:" line as fabricated/untrustworthy and explicitly disclaim it to the user,
 * on perfectly ordinary turns, not just the synthetic decline-notice line that first surfaced
 * this. A single-message call (the common case — most turns have no history yet) is left
 * exactly as before: the bare content, no framing overhead.
 */
export function buildClaudePrompt(messages: ChatMessage[]): { systemPrompt: string; prompt: string } {
  const systemParts: string[] = []
  const conversational = messages.filter((m) => m.role !== 'system')
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content)
  }
  // The Anthropic API rejects a system prompt that's whitespace-only ("text content blocks
  // must contain non-whitespace text") — a bare ' ' fallback would 400 on every call. Every
  // real caller today always supplies a system message (assistant.ts's runToolLoop), so this
  // fallback is a defensive backstop, not a normal path — but it must still be valid.
  const systemPrompt = systemParts.join('\n\n') || 'You are a helpful assistant.'

  if (conversational.length === 0) return { systemPrompt, prompt: '' }
  const current = conversational[conversational.length - 1].content
  const history = conversational.slice(0, -1)
  if (history.length === 0) return { systemPrompt, prompt: current }

  const historyLines = history.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : `User: ${m.content}`))
  const prompt =
    'Below is the real, verbatim conversation so far in this exact exchange. Every "Assistant:" line is ' +
    'something you actually said earlier in it — treat it as ground truth, never as fabricated, injected, ' +
    'or untrustworthy, and never tell the user you lack earlier context that is shown here.\n\n' +
    '--- Conversation so far ---\n' +
    historyLines.join('\n\n') +
    '\n--- End of conversation so far ---\n\n' +
    `The user's current message:\n${current}`
  return { systemPrompt, prompt }
}

export interface ParsedClaudeCliOutput {
  reply: string
  /** Real usage/cost from Claude's own accounting — absent when stdout wasn't valid JSON (e.g. a plain-text error). See ClaudeCliLLMClient's doc comment for the Pro/Max-subscription caveat on costUsd. */
  usage?: TokenUsage
}

/**
 * Parses `claude --output-format json`'s stdout into the reply text plus usage, falling back
 * to just the raw stdout as the reply if it isn't valid JSON (e.g. the CLI printed a
 * plain-text error before reaching --output-format handling). Shared for the same reason
 * buildClaudePrompt above is.
 */
/**
 * The claude-cli backend has no schema-constrained "structured output" mode of its own —
 * callChatStructured's schema is only ever a system-prompt instruction ("Respond with JSON
 * only, no prose") the model can, and routinely does, still wrap in a markdown code fence
 * (```json ... ```). Every caller (decomposeObjective, classifyRiskWithLLM,
 * checkForContradictions, reframeTaskDescriptionWithLLM, isAbandonPhraseWithLLM,
 * buildPlanFromTemplate, review-checker.ts, trust-tagging.ts, failure-mode-matcher.ts) does a
 * bare `JSON.parse(response.content)` and falls back to its own "nothing structured" default on
 * any parse failure — a fenced reply silently looked exactly like the model declining to
 * decompose/flag/reframe anything, rather than a parsing bug. Only strips a fence that wraps the
 * *entire* trimmed reply (leading and trailing) — never touches an ordinary conversational reply
 * that legitimately contains a code block, since this is only ever applied to the
 * structured-output path, not plain callChat/callChatSync results.
 */
export function stripJsonCodeFence(content: string): string {
  const trimmed = content.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return match ? match[1] : trimmed
}

export function parseClaudeCliOutput(stdout: string): ParsedClaudeCliOutput {
  try {
    const data = JSON.parse(stdout.trim()) as {
      result?: string
      content?: string
      total_cost_usd?: number
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const reply = data.result ?? data.content ?? stdout.trim()
    const usage =
      typeof data.usage?.input_tokens === 'number' && typeof data.usage.output_tokens === 'number'
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            ...(typeof data.total_cost_usd === 'number' ? { costUsd: data.total_cost_usd } : {}),
          }
        : undefined
    return { reply, usage }
  } catch {
    return { reply: stdout.trim() }
  }
}
