export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Set on a 'tool' message: the id of the tool_use block this is the result for (Anthropic's tool_use_id). Required to round-trip a tool result back to the API. */
    toolCallId?: string;
    /** Set on an 'assistant' message that made tool calls (content may be empty): the raw calls, needed to reconstruct the tool_use content blocks when this message is replayed in a later request. */
    toolCalls?: ToolCallResult[];
}
export interface ChatOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    structuredOutput?: {
        schema: Record<string, unknown>;
    };
    /**
     * Ask the provider to cache the prompt prefix (system text, tool definitions and the conversation so far) so the next call of a growing
     * conversation re-reads it at a fraction of the price. Honoured by AnthropicLLMClient and, for claude-* models, by LLMClient's structured calls through the proxy; other backends ignore it (OpenAI-compatible APIs cache on their own).
     */
    cachePrompt?: boolean;
    /**
     * Longest this one call may wait on the endpoint (response headers, a whole non-streamed body, or the gap between
     * streamed chunks) before it fails with a timeout error. Absent: the client's own bound, which for a structuredOutput call
     * (the small JSON side calls: classifier, audit, next steps, ...) is shorter than for a main chat call. Honoured by
     * OpenAICompatibleLLMClient; other backends ignore it.
     */
    timeoutMs?: number;
    /**
     * Cuts the call off when it aborts: the request is cancelled rather than left to run to its end. Honoured by AnthropicLLMClient,
     * OpenAICompatibleLLMClient and the Node Claude CLI client; other backends ignore it (callers also stop waiting for them).
     */
    signal?: AbortSignal;
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
    onToolStep?: (event: ToolStepEvent) => void;
    /**
     * Called once per call with token usage, when the backend/response actually reports it —
     * optional and best-effort, same "no-op if the caller doesn't listen" convention as
     * onToolStep, chosen over changing callChatSync/callChat's return type so every existing
     * call site and mock keeps compiling unchanged. See LLMClient's doc comments for exactly
     * when each backend can/can't supply this.
     */
    onUsage?: (usage: TokenUsage) => void;
    /**
     * Phase D0 (harness_consolidation_and_control_plane_plan.html): called BEFORE a backend's own
     * internal agentic loop actually executes a read-only tool call, when that backend can
     * intercept the call synchronously ahead of execution (see ClaudeCliLLMClient, which blocks
     * its MCP server on this over a loopback socket). This is the propose→gate half of
     * propose→gate→execute — unlike onToolStep (a same-shape but strictly informational,
     * after-the-fact notification), returning `{ decision: 'deny' }` here actually prevents the
     * call from running and the backend must surface the denial to the model as the tool's result.
     * A backend that already surfaces every tool call to the caller directly (one call per tool
     * round trip, e.g. the plain Anthropic API client) never calls this — the caller's own loop
     * gates the call itself before dispatching it. Absent for a caller that doesn't wire it in:
     * every proposal is allowed, i.e. today's behavior, unchanged.
     */
    onToolProposal?: (tool: string, input: Record<string, unknown>) => Promise<ToolProposalDecision>;
    /**
     * The propose→gate→execute→**report** half: called AFTER a backend's own internal agentic loop
     * executed a read-only tool call, with the raw text the tool returned (truncated by the sender).
     * Without it a caller sees such a call only as an `onToolStep` announcement — the result stays
     * inside the backend, so nothing downstream (e.g. the answer-claim grounding check) can compare a
     * reply to what the tool actually said. Informational only: the return value is ignored and a
     * throw is swallowed. A backend that hands every tool result to the caller directly (the proxy
     * client) never calls this.
     */
    onToolResult?: (tool: string, input: Record<string, unknown>, resultText: string, ok: boolean, notFound?: boolean) => void | Promise<void>;
    /**
     * Lets the caller execute a read-only network tool (fetch_url / web_search) itself instead of the
     * backend doing it inside its own subprocess. Return the text the model should see as the tool's
     * result — already trust-wrapped and injection-checked by the caller — or `undefined` to decline,
     * in which case the backend runs the tool itself exactly as before. Throwing reports the tool as
     * failed with the thrown message. Why: a backend-side fetch bypasses the caller's own web stack
     * (its SSRF guard, its injected `fetchImpl`, its LLM injection classifier), so those only applied
     * on backends that hand tool calls back one at a time. The proxy client never calls this.
     */
    onToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<string | undefined>;
}
export interface ToolStepEvent {
    tool: string;
    input: Record<string, unknown>;
}
/** See ChatOptions.onToolProposal. `reason` is required on `deny` — a caller surfacing this to
 * the model (or to a human) always needs to say why, never a bare rejection. */
export type ToolProposalDecision = {
    decision: 'allow';
} | {
    decision: 'deny';
    reason: string;
};
export interface ToolCallResult {
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface LLMStructuredResponse {
    content: string;
    toolCalls?: ToolCallResult[];
}
/**
 * Anthropic's input_tokens leaves out the tokens read from or written to its prompt cache, which come in their own fields; TokenUsage counts
 * them inside inputTokens (cached and written are subsets). With neither field reported the usage is as it was.
 */
export declare function withCacheCounts(usage: TokenUsage, read: number | undefined, written: number | undefined): TokenUsage;
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    /** Real dollar cost, when the backend can supply one (e.g. Claude CLI's --output-format json). Absent when only token counts are known — a caller wanting a dollar figure regardless must derive one from a pricing table itself. */
    costUsd?: number;
    /** How many of inputTokens were served from the provider's prompt cache — OpenAI-compatible
     * APIs (OpenAI direct, and OpenRouter for providers that support it) report this as
     * usage.prompt_tokens_details.cached_tokens. Absent when the backend doesn't report it at all
     * (not necessarily 0 — see OpenAICompatibleLLMClient's doc comment on where this is parsed). */
    cachedInputTokens?: number;
    /** How many of inputTokens were written to the provider's prompt cache on this call (Anthropic bills a write above the plain input rate). Absent when not reported. */
    cacheWriteTokens?: number;
}
export interface ToolDefinition {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}
export interface ILLMClient {
    /** False for a backend that runs its own tool loop and cannot return tool calls to the caller (the local `claude -p` client). Absent or true: callChatStructured takes tool definitions and returns tool calls. */
    readonly nativeToolCalls?: boolean;
    callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
    callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse>;
}
export declare class LLMClient implements ILLMClient {
    private proxyUrl;
    private authToken;
    private fetchImpl;
    /** `fetchImpl`: injectable fetch (the Tauri webview's CSP blocks the global one to remote hosts; the desktop app passes @tauri-apps/plugin-http's). Defaults to the global fetch. */
    constructor({ proxyUrl, authToken, fetchImpl }: {
        proxyUrl: string;
        authToken: string;
        fetchImpl?: typeof fetch;
    });
    callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
    callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse>;
}
