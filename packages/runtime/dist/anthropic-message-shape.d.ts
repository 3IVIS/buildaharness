import { ChatMessage, ToolCallResult } from './llm-client';
export type AnthropicContentBlock = {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
    cache_control?: {
        type: 'ephemeral';
    };
} | {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    cache_control?: {
        type: 'ephemeral';
    };
};
export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}
/**
 * Anthropic's Messages API takes `system` as a separate top-level string (not a
 * message with role 'system'), and expects a tool result back as a `user`
 * message containing a `tool_result` block keyed by `tool_use_id` — not a
 * message with role 'tool'. This reshapes our role-based ChatMessage[] into
 * that wire format. Consecutive 'tool' messages are batched into a single
 * user message with multiple tool_result blocks, matching how the API expects
 * the results of a multi-tool-call turn to come back in one round trip.
 *
 * Shared by LLMClient (the self-hosted-proxy client) and AnthropicLLMClient
 * (direct-to-API) so the two Anthropic-shaped clients can't silently drift apart.
 */
export declare function buildAnthropicMessages(messages: ChatMessage[]): {
    system?: string;
    messages: AnthropicMessage[];
};
/**
 * Parses an Anthropic Messages API response's `content` array (text + tool_use blocks) into
 * plain reply text plus structured tool calls. Shared by LLMClient's proxy path and
 * AnthropicLLMClient's direct path — both receive the identical response shape.
 */
export declare function parseAnthropicContentBlocks(content: unknown): {
    content: string;
    toolCalls?: ToolCallResult[];
};
/** Puts a cache breakpoint on the last content block of the last message, so everything before it is cached for the next call. */
export declare function markLastBlockCacheable(messages: AnthropicMessage[]): void;
