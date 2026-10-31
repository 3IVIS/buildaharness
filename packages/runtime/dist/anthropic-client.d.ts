import { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from './llm-client';
export interface AnthropicLLMClientOptions {
    apiKey: string;
    /** Injectable fetch — the Tauri webview's CSP blocks the global fetch to remote hosts, so the desktop app passes @tauri-apps/plugin-http's fetch here. Defaults to the global fetch. */
    fetchImpl?: typeof fetch;
    /** Longest a single wait on the API may take (headers, a whole non-streamed body, or the gap between streamed chunks) before the call fails with a timeout error. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
    requestTimeoutMs?: number;
    /** The same bound for a structuredOutput call (the small JSON side calls). Defaults to DEFAULT_STRUCTURED_REQUEST_TIMEOUT_MS. A per-call `ChatOptions.timeoutMs` overrides both. */
    structuredRequestTimeoutMs?: number;
}
/**
 * Direct-to-Anthropic ILLMClient — no self-hosted proxy involved. Used when a user pastes
 * their own Anthropic API key into Settings (config.llmBackend === 'anthropic') instead of
 * deploying packages/proxy. Reuses LLMClient's Anthropic message-shaping and response
 * parsing (anthropic-message-shape.ts) so the two Anthropic-shaped clients can't drift.
 *
 * Unlike LLMClient (which lets the proxy's own request body dictate `max_tokens`), the
 * Messages API rejects a request with no `max_tokens` at all, so this client always sends
 * one (options.maxTokens, or a default).
 *
 * `anthropic-dangerous-direct-browser-access: true` is Anthropic's documented opt-in for a
 * plain `fetch()` from a browser tab (otherwise CORS-rejected) — sent unconditionally since
 * it's harmless from Node/Tauri too, keeping this one implementation instead of a
 * browser-only branch.
 */
export declare class AnthropicLLMClient implements ILLMClient {
    private readonly apiKey;
    private readonly fetchImpl;
    private readonly requestTimeoutMs;
    private readonly structuredRequestTimeoutMs;
    constructor({ apiKey, fetchImpl, requestTimeoutMs, structuredRequestTimeoutMs }: AnthropicLLMClientOptions);
    private headers;
    /** One POST to the Messages API whose wait for the response headers is bounded; the request is aborted on timeout. */
    private post;
    private errorMessage;
    callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
    callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse>;
}
