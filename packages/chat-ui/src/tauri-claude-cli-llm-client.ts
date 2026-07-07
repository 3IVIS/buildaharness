import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ILLMClient, ChatMessage, ChatOptions, ToolDefinition, LLMStructuredResponse, ToolStepEvent } from '@buildaharness/runtime'
import {
  buildClaudePrompt,
  parseClaudeCliOutput,
  ALREADY_STAGED_ACTION_TOOL,
  stagedActionInput,
  type PendingActionRecord,
} from '@buildaharness/personal-assistant'

/** Event name run_claude_prompt_with_file_tools emits on — see src-tauri/src/lib.rs's TOOL_STEP_EVENT. */
const TOOL_STEP_EVENT = 'claude-tool-step'

export interface TauriClaudeCliLLMClientOptions {
  /**
   * When set, callChatStructured wires personal-assistant's file-tools MCP server into the
   * `claude -p` call (via the `run_claude_prompt_with_file_tools` Tauri command) instead of
   * throwing when tools are supplied. Absent by default — an ordinary chat turn stays
   * fully tool-free, exactly as before this option existed.
   */
  fileTools?: boolean
}

/**
 * ILLMClient backed by the desktop shell's `run_claude_prompt`/`run_claude_prompt_with_file_tools`
 * Tauri commands (see src-tauri/src/lib.rs) instead of an HTTP proxy — runs the desktop app
 * against the user's already-authenticated Claude Code CLI session, no ANTHROPIC_API_KEY
 * required. The desktop equivalent of personal-assistant's ClaudeCliLLMClient, which can't
 * run directly inside a webview because it needs node:child_process; buildClaudePrompt/
 * parseClaudeCliOutput/ALREADY_STAGED_ACTION_TOOL/stagedActionInput are all imported from
 * that same package so both front ends turn a transcript into a `claude -p` prompt, parse
 * its reply, and surface a staged write/shell action identically instead of drifting into
 * two implementations.
 */
export class TauriClaudeCliLLMClient implements ILLMClient {
  private readonly fileTools: boolean

  constructor(options: TauriClaudeCliLLMClientOptions = {}) {
    this.fileTools = options.fileTools ?? false
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    yield await this.callChatSync(messages, options)
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const { systemPrompt, prompt } = buildClaudePrompt(messages)
    const stdout = await invoke<string>('run_claude_prompt', { systemPrompt, prompt, model: options.model ?? null })
    const { reply, usage } = parseClaudeCliOutput(stdout)
    if (usage) options.onUsage?.(usage)
    return reply
  }

  async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    if (!tools || tools.length === 0) {
      return { content: await this.callChatSync(messages, options) }
    }
    if (!this.fileTools) {
      throw new Error('TauriClaudeCliLLMClient does not support tool calls unless constructed with fileTools enabled')
    }

    const { systemPrompt, prompt } = buildClaudePrompt(messages)

    // Tauri events are process-wide, not scoped to this one invoke() call — fine here since
    // PersonalAssistant only ever has one turn (and so one callChatStructured call) in
    // flight at a time; the listener is torn down as soon as this call settles either way.
    const unlisten = options.onToolStep
      ? await listen<ToolStepEvent>(TOOL_STEP_EVENT, (event) => options.onToolStep?.(event.payload))
      : undefined
    let outcome: { stdout: string; staged_action?: string }
    try {
      outcome = await invoke<{ stdout: string; staged_action?: string }>('run_claude_prompt_with_file_tools', {
        systemPrompt,
        prompt,
        model: options.model ?? null,
      })
    } finally {
      unlisten?.()
    }

    if (outcome.staged_action) {
      const record = JSON.parse(outcome.staged_action) as PendingActionRecord
      return {
        content: '',
        toolCalls: [{ id: `tauri-staged-${record.id}`, name: ALREADY_STAGED_ACTION_TOOL, input: stagedActionInput(record) }],
      }
    }
    const { reply, usage } = parseClaudeCliOutput(outcome.stdout)
    if (usage) options.onUsage?.(usage)
    return { content: reply }
  }
}
