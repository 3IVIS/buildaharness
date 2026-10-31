import { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from './llm-client';
export interface OpenAICompatibleLLMClientOptions {
    apiKey: string;
    baseUrl: string;
    /** Used whenever a call doesn't specify options.model — the caller picks this per provider (see OPENAI_DEFAULT_MODEL / OPENROUTER_DEFAULT_MODEL in model-defaults.ts) rather than this client inferring it from baseUrl. */
    defaultModel: string;
    /** OpenRouter's recommended (not required) HTTP-Referer/X-Title headers, or any other provider-specific extras — merged into every request. */
    extraHeaders?: Record<string, string>;
    /** Injectable fetch — the Tauri webview's CSP blocks the global fetch to remote hosts, so the desktop app passes @tauri-apps/plugin-http's fetch here. Defaults to the global fetch. */
    fetchImpl?: typeof fetch;
    /** Longest a single wait on the endpoint may take (headers, a whole non-streamed body, or the gap between streamed chunks) before the call fails with a timeout error. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
    requestTimeoutMs?: number;
    /** The same bound for a structuredOutput call (the small JSON side calls), which a healthy endpoint answers in seconds. Defaults to DEFAULT_STRUCTURED_REQUEST_TIMEOUT_MS. A per-call `ChatOptions.timeoutMs` overrides both. */
    structuredRequestTimeoutMs?: number;
}
/**
 * baseUrl/defaultModel for the two OpenAI-compatible providers this app wires up out of the
 * box — exported so every call site (CLI, chat-ui browser build, Tauri desktop build)
 * constructs an OpenAICompatibleLLMClient from the exact same values instead of each surface
 * hardcoding its own copy that can silently drift. The default-model ids themselves live in
 * model-defaults.ts (with ANTHROPIC_DEFAULT_MODEL) and are re-exported here so existing
 * `@buildaharness/runtime` importers are unaffected.
 */
export declare const OPENAI_BASE_URL = "https://api.openai.com/v1";
export declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export { OPENAI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL } from './model-defaults';
/**
 * OpenRouter's recommended (not required) leaderboard-attribution headers — see
 * https://openrouter.ai/docs. `HTTP-Referer` is rendered as the clickable link for
 * the app on OpenRouter's rankings, so it points at the product page rather than the
 * raw repo; `X-Title` is the display name shown there.
 */
export declare const OPENROUTER_EXTRA_HEADERS: Record<string, string>;
/**
 * ILLMClient for any endpoint that speaks OpenAI's Chat Completions wire format —
 * OpenAI itself and OpenRouter (an OpenAI-compatible endpoint by design) both go through
 * this one implementation, parameterized by baseUrl/defaultModel/extraHeaders rather than
 * two near-duplicate classes. See anthropic-client.ts's AnthropicLLMClient for the
 * Anthropic-Messages-API-shaped equivalent.
 */
export declare class OpenAICompatibleLLMClient implements ILLMClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly defaultModel;
    private readonly extraHeaders;
    private readonly fetchImpl;
    private readonly requestTimeoutMs;
    private readonly structuredRequestTimeoutMs;
    constructor({ apiKey, baseUrl, defaultModel, extraHeaders, fetchImpl, requestTimeoutMs, structuredRequestTimeoutMs }: OpenAICompatibleLLMClientOptions);
    /** One POST to chat/completions whose wait for the response headers is bounded; the request is aborted on timeout. */
    private post;
    private headers;
    private errorMessage;
    /**
     * ChatMessage[] → OpenAI's message shape. Unlike Anthropic, OpenAI takes a tool result
     * inline as a 'tool'-role message (no batching into a wrapper message needed) and a
     * tool-calling assistant turn as a `tool_calls` array on the assistant message itself,
     * not content blocks.
     */
    private buildMessages;
    callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
    callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse>;
}
