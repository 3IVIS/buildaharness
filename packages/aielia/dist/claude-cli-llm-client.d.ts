import { ILLMClient, ChatMessage, ChatOptions, ToolDefinition, LLMStructuredResponse } from '@buildaharness/runtime';
export interface ClaudeCliLLMClientOptions {
    /** Path to the claude binary. Defaults to CLAUDE_PATH env var, then 'claude' on PATH. */
    claudePath?: string;
    /**
     * When set, callChatStructured wires in the file-tools MCP server (read_file/
     * list_directory/write_file, scoped to workspaceRoot) via --mcp-config instead
     * of throwing when tools are supplied. Absent by default — an ordinary chat
     * turn through this backend stays fully tool-free, exactly as before.
     */
    fileTools?: {
        workspaceRoot: string;
    };
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
    remindersFile?: string;
    /**
     * When set, also registers run_shell_command on the same MCP server (started
     * whenever fileTools or shellTools is configured) — gated behind an env var
     * the same way reminders are gated behind `remindersFile`. Bash itself is
     * never added to --tools regardless of this setting — see the class doc
     * comment. Kept as a separate option from fileTools so a caller can enable
     * shell without file access or vice versa, even though `workspaceRoot` is
     * typically the same value for both on this backend.
     */
    shellTools?: {
        workspaceRoot: string;
    };
    /**
     * When set, also registers `web_search` on the same MCP server (started
     * whenever fileTools, shellTools, or webTools is configured), backed by the
     * Brave Search API (the only backend — see web-search-provider.ts). Gated
     * behind the `BRAVE_SEARCH_API_KEY` env var passed to the server, the same
     * way shell is gated behind `ENABLE_SHELL_TOOLS`. `fetch_url` is registered
     * independently whenever the server runs at all — this option only adds the
     * search half.
     */
    webTools?: {
        braveApiKey?: string;
    };
    /**
     * When set, also registers send_email on the same MCP server (started whenever any of
     * fileTools/shellTools/webTools/actionTools is configured), gated behind an env var the same
     * way run_shell_command is. The MCP server only ever *stages* the message — the parent process
     * delivers it, after approval, through its own configured SendEmail transport (email.ts /
     * email-smtp.ts). Kept separate from fileTools so email can be enabled without file access.
     */
    actionTools?: {
        workspaceRoot: string;
    };
    /**
     * Default model passed as `--model` to every `claude -p` call when the per-call
     * `ChatOptions.model` doesn't already set one. The benchmark (Plan A1) uses this to pin every
     * audit run to a stated model instead of silently inheriting the CLI default. `undefined` keeps
     * the pre-A1 behaviour (no `--model` flag → CLI default).
     */
    model?: string;
}
/**
 * ILLMClient backed by a local `claude -p` subprocess instead of a hosted API key —
 * runs PersonalAssistant against an already-authenticated Claude Code CLI session.
 * Always passes --system-prompt (so the CLI's own default prompt/project instructions/skills
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
export declare class ClaudeCliLLMClient implements ILLMClient {
    /** Runs its own tool loop inside `claude -p`; it cannot return tool calls to a caller's loop, so those callers use text tool calls (see writer/text-tool-calls.ts). */
    readonly nativeToolCalls = false;
    private readonly claudePath;
    private readonly fileTools?;
    private readonly remindersFile?;
    private readonly shellTools?;
    private readonly webTools?;
    private readonly actionTools?;
    private readonly model?;
    /**
     * The concrete model id the last `claude -p` call actually reported running against (read from
     * the response's own `model` field, not the CLI alias). `undefined` until a call resolves one.
     * Plan A1 records this into the benchmark report so a published table can name the model.
     */
    resolvedModelId?: string;
    constructor(options?: ClaudeCliLLMClientOptions);
    callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
    callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
    /**
     * When `tools` is non-empty and `fileTools`/`shellTools` was configured, wires the
     * file-tools MCP server into a single `claude -p` call and lets Claude Code's own
     * agentic loop call read_file/list_directory/write_file/fetch_url/create_reminder/
     * list_reminders/run_shell_command autonomously — we don't get to intercept each
     * call the way the proxy backend's manual tool loop does (see
     * the internal plan, T6). fetch_url is always
     * registered on that server; create_reminder/list_reminders only when
     * `remindersFile` is set; run_shell_command only when `shellTools` is set;
     * web_search only when `webTools` is set (Brave Search — see the `webTools`
     * option). Three
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
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse>;
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
    private findPendingActionStagedSince;
}
