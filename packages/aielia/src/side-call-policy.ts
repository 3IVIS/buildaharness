import { isRequestTimeout, type ChatMessage, type ChatOptions, type ILLMClient, type LLMStructuredResponse, type ToolDefinition } from '@buildaharness/runtime'

/**
 * The small structured JSON calls a turn makes around its reply (risk classification, scope and goal-thread matching, the reply
 * audit and its second sample, next steps) are quick on a healthy endpoint, but some calls simply never answer: in the
 * benchmark about one call in four sat for minutes while the rest took seconds, and a turn waits on all of them, so a
 * finished-looking reply stayed busy for minutes and a message queued meanwhile started late (scenarios 05, 06, 09, 10, 13, 15).
 * Measured on the benchmark's model through OpenRouter (40 audit-sized calls, 8 at a time): median 2.5 s, 95th percentile 12 s,
 * slowest 16 s. So a first attempt gets 45 s, and a call that timed out is asked once more with 60 s (a new connection usually
 * lands on a healthy route). Only a timeout is retried: a refusal or a bad answer would come back the same.
 */
export const SIDE_CALL_TIMEOUT_MS = 45_000
export const SIDE_CALL_RETRY_TIMEOUT_MS = 60_000

/** Wraps a client so every structuredOutput call (never a main chat or tool-loop call) is bounded and retried once after a timeout. */
export function withSideCallPolicy(client: ILLMClient, onRetry?: (attempt: { timeoutMs: number }) => void): ILLMClient {
  return {
    callChat: (messages: ChatMessage[], options?: ChatOptions) => client.callChat(messages, options),
    callChatSync: (messages: ChatMessage[], options?: ChatOptions) => client.callChatSync(messages, options),
    async callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      if (!options?.structuredOutput) return client.callChatStructured(messages, tools, options)
      const firstMs = options.timeoutMs ?? SIDE_CALL_TIMEOUT_MS
      try {
        return await client.callChatStructured(messages, tools, { ...options, timeoutMs: firstMs })
      } catch (err) {
        if (!isRequestTimeout(err)) throw err
        onRetry?.({ timeoutMs: firstMs })
        return client.callChatStructured(messages, tools, { ...options, timeoutMs: Math.max(firstMs, SIDE_CALL_RETRY_TIMEOUT_MS) })
      }
    },
  }
}
