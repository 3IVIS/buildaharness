import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ILLMClient, ChatMessage, ChatOptions, ToolDefinition, LLMStructuredResponse } from '@buildaharness/runtime'
import type { PendingWriteRecord } from './file-tools.js'

/** Synthetic tool name ClaudeCliLLMClient uses to signal "a write was already staged by the MCP server during this call" — distinct from `write_file` so assistant.ts's tool loop doesn't try to stage it a second time. */
const ALREADY_STAGED_WRITE_TOOL = '__staged_write'

export interface ClaudeCliLLMClientOptions {
  /** Path to the claude binary. Defaults to CLAUDE_PATH env var, then 'claude' on PATH. */
  claudePath?: string
  /**
   * When set, callChatStructured wires in the file-tools MCP server (read_file/
   * list_directory/write_file, scoped to workspaceRoot) via --mcp-config instead
   * of throwing when tools are supplied. Absent by default — an ordinary chat
   * turn through this backend stays fully tool-free, exactly as before.
   */
  fileTools?: { workspaceRoot: string }
}

function buildPrompt(messages: ChatMessage[]): { systemPrompt: string; prompt: string } {
  const systemParts: string[] = []
  const turns: string[] = []
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content)
    else if (m.role === 'assistant') turns.push(`Assistant: ${m.content}`)
    else turns.push(m.content)
  }
  return { systemPrompt: systemParts.join('\n\n') || ' ', prompt: turns.join('\n\n') }
}

function invokeClaude(claudePath: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(claudePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`))
        return
      }
      try {
        const data = JSON.parse(stdout.trim()) as { result?: string; content?: string }
        resolvePromise(data.result ?? data.content ?? stdout.trim())
      } catch {
        resolvePromise(stdout.trim())
      }
    })
  })
}

/**
 * ILLMClient backed by a local `claude -p` subprocess instead of a hosted API key —
 * runs PersonalAssistant against an already-authenticated Claude Code CLI session.
 * Always passes --system-prompt (so the CLI's own default prompt/CLAUDE.md/skills
 * never leak into an ordinary chat turn) and --tools "" (PersonalAssistant only
 * ever calls callChatSync — there's nothing here that expects tool use).
 */
export class ClaudeCliLLMClient implements ILLMClient {
  private readonly claudePath: string
  private readonly fileTools?: { workspaceRoot: string }

  constructor(options: ClaudeCliLLMClientOptions = {}) {
    this.claudePath = options.claudePath ?? process.env.CLAUDE_PATH ?? 'claude'
    this.fileTools = options.fileTools
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    yield await this.callChatSync(messages, options)
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const { systemPrompt, prompt } = buildPrompt(messages)
    const args = ['--print', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--system-prompt', systemPrompt]
    if (options.model) args.push('--model', options.model)
    args.push(prompt)
    return invokeClaude(this.claudePath, args)
  }

  /**
   * When `tools` is non-empty and `fileTools` was configured, wires the file-tools
   * MCP server into a single `claude -p` call and lets Claude Code's own agentic
   * loop call read_file/list_directory/write_file autonomously — we don't get to
   * intercept each call the way the proxy backend's manual tool loop does (see
   * plans/personal_assistant_file_tools_plan.html, T6). Two possible outcomes:
   * a final text reply (no tool call this backend needs to surface), or a write
   * staged by the MCP server mid-call, surfaced as a synthetic `__staged_write`
   * tool call so assistant.ts's tool loop treats it the same as a manually staged
   * write without staging it a second time.
   */
  async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    if (!tools || tools.length === 0) {
      return { content: await this.callChatSync(messages, options) }
    }
    if (!this.fileTools) {
      throw new Error('ClaudeCliLLMClient does not support tool calls unless constructed with fileTools configured')
    }

    const { systemPrompt, prompt } = buildPrompt(messages)
    // Deliberately not `new URL('./file-tools-mcp-server.mjs', import.meta.url)` as a
    // single literal — Vite's asset-URL plugin statically detects that exact pattern
    // and inlines the whole file as a base64 data: URL at build time, which
    // fileURLToPath can't turn back into a real path. Building the specifier from a
    // variable keeps this a plain runtime URL resolution instead.
    const mcpServerFileName = 'file-tools-mcp-server.mjs'
    const mcpServerPath = fileURLToPath(new URL(mcpServerFileName, import.meta.url))
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'file-tools': {
          command: 'node',
          args: [mcpServerPath],
          env: { WORKSPACE_ROOT: this.fileTools.workspaceRoot },
        },
      },
    })

    const args = [
      '--print',
      '--output-format', 'json',
      '--tools', '', // still disable Claude Code's own built-in Read/Write/Bash tools
      '--no-session-persistence',
      '--system-prompt', systemPrompt,
      '--mcp-config', mcpConfig,
      '--strict-mcp-config', // ignore any ambient project .mcp.json — the tool surface must be exactly this plan's three tools
      '--dangerously-skip-permissions', // headless -p mode has no way to answer an interactive tool-permission prompt
    ]
    if (options.model) args.push('--model', options.model)
    args.push(prompt)

    const callStartedAt = Date.now()
    const content = await invokeClaude(this.claudePath, args)
    const staged = await this.findPendingWriteStagedSince(this.fileTools.workspaceRoot, callStartedAt)

    if (staged) {
      return {
        content: '',
        toolCalls: [{ id: `cli-staged-${staged.id}`, name: ALREADY_STAGED_WRITE_TOOL, input: { id: staged.id, path: staged.path, content: staged.content } }],
      }
    }
    return { content }
  }

  /** Diffs .pending-writes/ against the call's start time to detect a write the MCP server staged during this subprocess call. */
  private async findPendingWriteStagedSince(workspaceRoot: string, startTimeMs: number): Promise<PendingWriteRecord | undefined> {
    const dir = `${workspaceRoot}/.pending-writes`
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return undefined
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const filePath = `${dir}/${name}`
      const stats = await stat(filePath)
      // Small buffer against filesystem mtime rounding (e.g. 1s resolution on some
      // filesystems) being coarser than Date.now()'s precision.
      if (stats.mtimeMs < startTimeMs - 1000) continue
      return JSON.parse(await readFile(filePath, 'utf-8')) as PendingWriteRecord
    }
    return undefined
  }
}
