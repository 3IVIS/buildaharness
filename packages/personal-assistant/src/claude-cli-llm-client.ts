import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:net'
import type { ILLMClient, ChatMessage, ChatOptions, ToolDefinition, LLMStructuredResponse, ToolStepEvent, ToolProposalDecision } from '@buildaharness/runtime'
import type { PendingActionRecord } from './file-tools.js'
import { buildClaudePrompt, parseClaudeCliOutput, stripJsonCodeFence, ALREADY_STAGED_ACTION_TOOL, stagedActionInput, type ParsedClaudeCliOutput } from './claude-cli-prompt.js'
import { stripMcpToolPrefix } from './tool-step.js'

/**
 * `--tools ""` only disables Claude Code's own built-in tools (Read/Write/Bash/etc.) — it
 * has no effect on MCP servers, which are controlled entirely by --mcp-config/
 * --strict-mcp-config. Without this, a plain callChatSync call silently inherits whatever
 * MCP servers happen to be configured ambiently (a project .mcp.json, or the user's own
 * global Claude Code config) — an ordinary PersonalAssistant chat turn must not pick up
 * unrelated tools the user happens to have configured for their own interactive sessions.
 * An empty --mcp-config plus --strict-mcp-config guarantees zero MCP servers, the same way
 * --tools "" guarantees zero built-ins.
 */
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} })

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
  /**
   * When set (and fileTools is also set — the MCP server only starts at all
   * when fileTools is configured), also registers create_reminder/list_reminders
   * on the same MCP server, backed by this file. Must point at the exact file a
   * `FileSystemAdapter` (namespace "reminders") would use for the key
   * "reminders" — see file-tools-mcp-server.mjs's doc comment — so this
   * subprocess and the parent process's own ReminderStore share one reminder
   * list instead of drifting into two disconnected ones. Absent by default —
   * those two tools stay unregistered, same as before this option existed.
   * fetch_url needs no such option: it's registered unconditionally whenever
   * fileTools is set, since it has no shared-state dependency to configure.
   */
  remindersFile?: string
  /**
   * When set, also registers run_shell_command on the same MCP server (started
   * whenever fileTools or shellTools is configured) — gated behind an env var
   * the same way reminders are gated behind `remindersFile`. Bash itself is
   * never added to --tools regardless of this setting — see the class doc
   * comment. Kept as a separate option from fileTools so a caller can enable
   * shell without file access or vice versa, even though `workspaceRoot` is
   * typically the same value for both on this backend.
   */
  shellTools?: { workspaceRoot: string }
  /**
   * When set, also registers `web_search` on the same MCP server (started
   * whenever fileTools, shellTools, or webTools is configured), backed by
   * DuckDuckGo (keyless, the default) or the Brave Search API. Gated behind the
   * `WEB_SEARCH_BACKEND` env var passed to the server, the same way shell is
   * gated behind `ENABLE_SHELL_TOOLS`. `fetch_url` is registered independently
   * whenever the server runs at all — this option only adds the search half,
   * closing the gap where the keyless first-run-recommended backend couldn't
   * browse (see web-search-provider.ts).
   */
  webTools?: { searchBackend?: 'ddg' | 'brave'; braveApiKey?: string }
  /**
   * When set, also registers send_email on the same MCP server (started whenever any of
   * fileTools/shellTools/webTools/actionTools is configured), gated behind an env var the same
   * way run_shell_command is. The MCP server only ever *stages* the message — the parent process
   * delivers it, after approval, through its own configured SendEmail transport (email.ts /
   * email-smtp.ts). Kept separate from fileTools so email can be enabled without file access.
   */
  actionTools?: { workspaceRoot: string }
}

/**
 * Runs `claude` with cwd pinned to the OS temp directory, never the caller's actual
 * working directory — `claude` has no flag to suppress project-context loading, it
 * infers it entirely from the process's cwd (project CLAUDE.md, .mcp.json, skills, all
 * auto-loaded regardless of --system-prompt/--tools). Since PersonalAssistant's whole
 * point is a plain personal-assistant persona, not a coding agent scoped to whatever
 * repo happens to be the launch directory, every invocation runs from a directory that's
 * essentially guaranteed to have none of that project-level config to auto-load.
 */
function invokeClaude(claudePath: string, args: string[]): Promise<ParsedClaudeCliOutput> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(claudePath, args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] })
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
      resolvePromise(parseClaudeCliOutput(stdout))
    })
  })
}

/**
 * Same subprocess-invocation contract as invokeClaude, but for a `--output-format
 * stream-json` call (requires `--verbose` — enforced by whichever caller builds `args`):
 * parses newline-delimited JSON events as they arrive so tool_use blocks can be reported
 * live via onToolStep — otherwise invisible, since Claude Code's own agentic loop resolves
 * every tool call inside this one subprocess call before returning. The final answer still
 * comes from the last `result`-type event, in the exact same shape/field names
 * --output-format json's single object uses, so parseClaudeCliOutput's existing
 * result/content/fallback logic covers it unchanged — just handed one line instead of the
 * whole stdout.
 */
function invokeClaudeStreaming(claudePath: string, args: string[], onToolStep?: (event: ToolStepEvent) => void): Promise<ParsedClaudeCliOutput> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(claudePath, args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let finalResultLine: string | undefined

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.trim()) continue

        let event: { type?: string; message?: { content?: unknown[] } }
        try {
          event = JSON.parse(line)
        } catch {
          continue // stream-json is one complete JSON object per line — an unparseable line is never expected, but must never crash the stream
        }

        if (event.type === 'assistant' && onToolStep) {
          for (const block of event.message?.content ?? []) {
            if ((block as { type?: string }).type !== 'tool_use') continue
            const toolUse = block as { name: string; input?: Record<string, unknown> }
            onToolStep({ tool: stripMcpToolPrefix(toolUse.name), input: toolUse.input ?? {} })
          }
        } else if (event.type === 'result') {
          finalResultLine = line
        }
      }
    })
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`))
        return
      }
      resolvePromise(parseClaudeCliOutput(finalResultLine ?? ''))
    })
  })
}

/**
 * Phase D0 (harness_consolidation_and_control_plane_plan.html): a synchronous, per-call gate the
 * file-tools MCP server (spawned as this `claude` subprocess's own child — see
 * file-tools-mcp-server.mjs) blocks on before executing a read-only tool (read_file/
 * list_directory/fetch_url/web_search/create_reminder/list_reminders). write_file/
 * run_shell_command/send_email are unaffected — they already stage unconditionally and never
 * call this gate.
 *
 * Without this, Claude Code's own agentic loop resolves those read-only calls entirely inside
 * this one subprocess call: the deterministic, harness-informed check the proxy backend's manual
 * tool loop already runs before every call (agent-loop.ts's checkToolPolicy) never ran for this
 * backend at all — onToolStep only reports the call after Claude Code has already decided to
 * make it, too late to gate.
 *
 * Listens on an ephemeral loopback TCP port for the lifetime of one callChatStructured call;
 * newline-delimited JSON request/response, one request per tool call (`{tool, input}` in,
 * `{decision, reason?}` out — see ChatOptions.onToolProposal). Absent `onToolProposal` (a caller
 * that hasn't wired the gate), or an unparseable request, every proposal is allowed — the
 * pre-D0 behavior, unchanged.
 */
function startToolGateServer(
  onToolProposal?: (tool: string, input: Record<string, unknown>) => Promise<ToolProposalDecision>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          if (!line.trim()) continue
          void (async (requestLine: string) => {
            let request: { tool?: unknown; input?: unknown }
            try {
              request = JSON.parse(requestLine)
            } catch {
              socket.write(`${JSON.stringify({ decision: 'allow' })}\n`)
              return
            }
            let decision: ToolProposalDecision
            try {
              decision =
                onToolProposal && typeof request.tool === 'string'
                  ? await onToolProposal(request.tool, (request.input as Record<string, unknown>) ?? {})
                  : { decision: 'allow' }
            } catch (err) {
              // onToolProposal (agent-loop.ts's wiring) can throw — e.g. a tracing hook
              // (onTrace) called from inside checkToolPolicy. Left uncaught, this rejection
              // is unhandled inside the fire-and-forget IIFE below and crashes the whole
              // process under Node's default throw-on-unhandledRejection. Fail open here,
              // the same posture file-tools-mcp-server.mjs's requestToolGate already takes
              // on its own transport errors (ADR-003 decision 10's injection-detector
              // fail-open) — this is defense-in-depth on top of the real sandboxing/staging
              // boundaries, not itself the security control.
              console.error('claude-cli tool gate: onToolProposal threw — failing open:', err)
              decision = { decision: 'allow' }
            }
            socket.write(`${JSON.stringify(decision)}\n`)
          })(line)
        }
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('tool gate server failed to bind to a loopback TCP port'))
        return
      }
      resolvePromise({ server, port: address.port })
    })
  })
}

/**
 * ILLMClient backed by a local `claude -p` subprocess instead of a hosted API key —
 * runs PersonalAssistant against an already-authenticated Claude Code CLI session.
 * Always passes --system-prompt (so the CLI's own default prompt/CLAUDE.md/skills
 * never leak into an ordinary chat turn) and --tools "" (PersonalAssistant only
 * ever calls callChatSync — there's nothing here that expects tool use). **Bash is
 * never added to --tools, under any configuration** — run_shell_command instead goes
 * through the same MCP server as the file tools, which only stages (never executes),
 * exactly like write_file: once a built-in like Bash is active, Claude Code's own
 * agentic loop would execute it autonomously within the single `claude -p` call, with
 * no point at which our code sees the command before it runs.
 *
 * **onUsage's costUsd caveat:** token counts (`inputTokens`/`outputTokens`) are always real —
 * they come straight from `claude --output-format json`'s `usage` field. `costUsd` comes from
 * that same response's `total_cost_usd`, which reflects real API billing when the underlying
 * `claude` session is authenticated with an API key, but may read `0` when it's authenticated
 * against a Pro/Max subscription instead (no per-call dollar cost to report). A caller
 * presenting this to a user (see personal-assistant's /cost) must not read a `0` here as "this
 * turn was free" without that context.
 */
export class ClaudeCliLLMClient implements ILLMClient {
  private readonly claudePath: string
  private readonly fileTools?: { workspaceRoot: string }
  private readonly remindersFile?: string
  private readonly shellTools?: { workspaceRoot: string }
  private readonly webTools?: { searchBackend?: 'ddg' | 'brave'; braveApiKey?: string }
  private readonly actionTools?: { workspaceRoot: string }

  constructor(options: ClaudeCliLLMClientOptions = {}) {
    this.claudePath = options.claudePath ?? process.env.CLAUDE_PATH ?? 'claude'
    this.fileTools = options.fileTools
    this.remindersFile = options.remindersFile
    this.shellTools = options.shellTools
    this.webTools = options.webTools
    this.actionTools = options.actionTools
  }

  async *callChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    yield await this.callChatSync(messages, options)
  }

  async callChatSync(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const { systemPrompt, prompt } = buildClaudePrompt(messages)
    const args = [
      '--print',
      '--output-format', 'json',
      '--tools', '',
      '--no-session-persistence',
      '--system-prompt', systemPrompt,
      '--mcp-config', EMPTY_MCP_CONFIG,
      '--strict-mcp-config', // ignore any ambient project/user MCP config — see EMPTY_MCP_CONFIG's doc comment
    ]
    if (options.model) args.push('--model', options.model)
    args.push(prompt)
    const { reply, usage } = await invokeClaude(this.claudePath, args)
    if (usage) options.onUsage?.(usage)
    return reply
  }

  /**
   * When `tools` is non-empty and `fileTools`/`shellTools` was configured, wires the
   * file-tools MCP server into a single `claude -p` call and lets Claude Code's own
   * agentic loop call read_file/list_directory/write_file/fetch_url/create_reminder/
   * list_reminders/run_shell_command autonomously — we don't get to intercept each
   * call the way the proxy backend's manual tool loop does (see
   * plans/personal_assistant_file_tools_plan.html, T6). fetch_url is always
   * registered on that server; create_reminder/list_reminders only when
   * `remindersFile` is set; run_shell_command only when `shellTools` is set;
   * web_search only when `webTools` is set (DuckDuckGo by default, Brave with a
   * key — see the `webTools` option). Three
   * possible outcomes: a final text reply (no tool call this backend needs to
   * surface), a write or shell command staged by the MCP server mid-call (surfaced
   * as a synthetic `__staged_action` tool call so assistant.ts's tool loop treats it
   * the same as a manually staged action without staging it a second time), or —
   * for fetch_url/create_reminder/list_reminders — the tool's result text folded
   * directly into Claude Code's own reply, since (unlike the proxy backend's
   * `executeToolCall`) there's no outer loop here to intercept each call and
   * re-apply trust-tagging itself; the MCP server tags fetch_url's result before
   * Claude Code ever sees it instead (see file-tools-mcp-server.mjs).
   */
  async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options: ChatOptions = {}): Promise<LLMStructuredResponse> {
    if (!tools || tools.length === 0) {
      // See stripJsonCodeFence's doc comment: this backend has no real schema-constrained
      // output mode, so a caller expecting bare JSON in `content` (per options.structuredOutput)
      // needs any markdown fence the model wrapped it in removed here, once, rather than in
      // every individual JSON.parse(response.content) call site.
      const content = await this.callChatSync(messages, options)
      return { content: options.structuredOutput ? stripJsonCodeFence(content) : content }
    }
    if (!this.fileTools && !this.shellTools && !this.webTools && !this.actionTools) {
      throw new Error(
        'ClaudeCliLLMClient does not support tool calls unless constructed with fileTools, shellTools, webTools, or actionTools configured',
      )
    }

    const { systemPrompt, prompt } = buildClaudePrompt(messages)
    // web_search / send_email need no workspace; fall back to the temp dir when one of those is
    // the only capability configured (the CLI always sets fileTools for this backend, so in
    // practice this is the real workspace root).
    const workspaceRoot =
      this.fileTools?.workspaceRoot ?? this.shellTools?.workspaceRoot ?? this.actionTools?.workspaceRoot ?? tmpdir()
    // The current turn's raw user message, before Claude Code's own agentic loop (and any
    // rewording it does before calling a tool) ever sees it — passed through to the MCP
    // server so create_reminder can check the *original* phrasing against fact-shaped
    // markers, not just whatever `text` the model decided to pass as the tool argument
    // (which is routinely reworded to third person, e.g. "I'm allergic to peanuts, please
    // remember that" → "User is allergic to peanuts", dodging a check against `text` alone).
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    // Deliberately not `new URL('./file-tools-mcp-server.mjs', import.meta.url)` as a
    // single literal — Vite's asset-URL plugin statically detects that exact pattern
    // and inlines the whole file as a base64 data: URL at build time, which
    // fileURLToPath can't turn back into a real path. Building the specifier from a
    // variable keeps this a plain runtime URL resolution instead.
    const mcpServerFileName = 'file-tools-mcp-server.mjs'
    const mcpServerPath = fileURLToPath(new URL(mcpServerFileName, import.meta.url))
    // Phase D0: gates read_file/list_directory/fetch_url/web_search/create_reminder/
    // list_reminders — see startToolGateServer's doc comment. Started before the config is
    // built (its port needs to go into TOOL_GATE_PORT) and always closed once this call
    // finishes, gate-decision or not.
    const gate = await startToolGateServer(options.onToolProposal)
    try {
      const mcpConfig = JSON.stringify({
        mcpServers: {
          'file-tools': {
            command: 'node',
            args: [mcpServerPath],
            env: {
              WORKSPACE_ROOT: workspaceRoot,
              TOOL_GATE_PORT: String(gate.port),
              ...(this.remindersFile ? { REMINDERS_FILE: this.remindersFile, CURRENT_USER_MESSAGE: lastUserMessage } : {}),
              ...(this.shellTools ? { ENABLE_SHELL_TOOLS: '1' } : {}),
              ...(this.webTools
                ? {
                    WEB_SEARCH_BACKEND: this.webTools.searchBackend ?? 'ddg',
                    ...(this.webTools.braveApiKey ? { BRAVE_SEARCH_API_KEY: this.webTools.braveApiKey } : {}),
                  }
                : {}),
              ...(this.actionTools ? { ENABLE_EMAIL_TOOL: '1' } : {}),
            },
          },
        },
      })

      const args = [
        '--print',
        '--output-format', 'stream-json', // streamed (not the single-object 'json') so tool_use events can be reported live via onToolStep — see invokeClaudeStreaming
        '--verbose', // required by --print when --output-format is stream-json
        '--tools', '', // still disable Claude Code's own built-in Read/Write/Bash tools — Bash is never added, regardless of shellTools
        '--no-session-persistence',
        '--system-prompt', systemPrompt,
        '--mcp-config', mcpConfig,
        '--strict-mcp-config', // ignore any ambient project .mcp.json — the tool surface must be exactly this plan's tools
        '--dangerously-skip-permissions', // headless -p mode has no way to answer an interactive tool-permission prompt
      ]
      if (options.model) args.push('--model', options.model)
      args.push(prompt)

      const callStartedAt = Date.now()
      const { reply, usage } = await invokeClaudeStreaming(this.claudePath, args, options.onToolStep)
      if (usage) options.onUsage?.(usage)
      const staged = await this.findPendingActionStagedSince(workspaceRoot, callStartedAt)

      if (staged) {
        return {
          content: '',
          toolCalls: [{ id: `cli-staged-${staged.id}`, name: ALREADY_STAGED_ACTION_TOOL, input: stagedActionInput(staged) }],
        }
      }
      return { content: reply }
    } finally {
      gate.server.close()
    }
  }

  /** Diffs .pending-actions/ against the call's start time to detect a write or shell command the MCP server staged during this subprocess call. */
  /**
   * When the MCP server staged more than one action this call (e.g. "run X AND write Y" —
   * see file-tools-mcp-server.mjs's stagePendingAction doc comment), every one of them lands
   * in `.pending-actions/` with an mtime after `startTimeMs`, in `readdir`-arbitrary order —
   * not necessarily staging order. Must return the *chain head* (earliest `stagedAt`)
   * specifically, since resolvePendingAction (assistant.ts) walks `nextPendingActionId`
   * forward from whichever record it's handed; returning a later link here would surface the
   * chain out of order and orphan the earlier, still-unresolved action.
   */
  private async findPendingActionStagedSince(workspaceRoot: string, startTimeMs: number): Promise<PendingActionRecord | undefined> {
    const dir = `${workspaceRoot}/.pending-actions`
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return undefined
    }
    let earliest: PendingActionRecord | undefined
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const filePath = `${dir}/${name}`
      const stats = await stat(filePath)
      // Small buffer against filesystem mtime rounding (e.g. 1s resolution on some
      // filesystems) being coarser than Date.now()'s precision.
      if (stats.mtimeMs < startTimeMs - 1000) continue
      const record = JSON.parse(await readFile(filePath, 'utf-8')) as PendingActionRecord
      if (!earliest || record.stagedAt < earliest.stagedAt) earliest = record
    }
    return earliest
  }
}
