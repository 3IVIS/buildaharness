import { isRequestTimeout, type ChatMessage, type ChatOptions, type ILLMClient, type LLMStructuredResponse, type ToolDefinition } from '@buildaharness/runtime'

/**
 * The small structured JSON calls a turn makes around its reply (risk classification, scope and goal-thread matching, the reply
 * audit and its extra samples, next steps) are quick on a healthy endpoint, but a few simply never answer, and a turn waits on all of
 * them: in the benchmark a finished-looking reply stayed busy for minutes and a queued message started late (scenarios 05, 06, 09, 10,
 * 13, 15). Measured on the benchmark's model through OpenRouter with the real risk-classifier prompt (16 calls, 4 at a time): median
 * 12 s, 75th percentile 27 s, 90th percentile 59 s, and one call that had not answered after 300 s. So a legitimate answer can take
 * about a minute, and a fixed short bound kills those (a 45 s bound did: two turns of benchmark scenario 03 ended as "risk
 * classification failed" and were never answered), while a long bound makes every hang cost minutes.
 *
 * So the call is hedged instead of cut off: when the first attempt has not answered after HEDGE_AFTER_MS a second identical attempt
 * starts beside it, and whichever answers first is used. A slow answer is never discarded, a hung call costs about the hedge delay
 * plus a normal response, and each attempt keeps its own hard bound. Only a timeout is hedged on the failure path: a refusal or a
 * malformed answer would come back the same, so it is returned at once.
 */
export const SIDE_CALL_HEDGE_AFTER_MS = 25_000
export const SIDE_CALL_TIMEOUT_MS = 120_000

export interface SideCallPolicyOptions {
  /** Called once when a second attempt is started because the first has not answered yet. */
  onHedge?: (info: { afterMs: number }) => void
  /** Test hook: how long the first attempt gets before the second starts. */
  hedgeAfterMs?: number
}

/** Wraps a client so every structuredOutput call (never a main chat or tool-loop call) is hedged as described above. */
export function withSideCallPolicy(client: ILLMClient, policy: SideCallPolicyOptions = {}): ILLMClient {
  const hedgeAfterMs = policy.hedgeAfterMs ?? SIDE_CALL_HEDGE_AFTER_MS
  return {
    callChat: (messages: ChatMessage[], options?: ChatOptions) => client.callChat(messages, options),
    callChatSync: (messages: ChatMessage[], options?: ChatOptions) => client.callChatSync(messages, options),
    callChatStructured(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMStructuredResponse> {
      if (!options?.structuredOutput) return client.callChatStructured(messages, tools, options)
      const timeoutMs = options.timeoutMs ?? SIDE_CALL_TIMEOUT_MS
      const attempt = (): Promise<LLMStructuredResponse> => client.callChatStructured(messages, tools, { ...options, timeoutMs })
      return new Promise<LLMStructuredResponse>((resolve, reject) => {
        let settled = false
        let running = 0
        let started = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (): void => { settled = true; if (timer) clearTimeout(timer) }
        const start = (): void => {
          running++
          started++
          attempt().then(
            (value) => { if (!settled) { done(); resolve(value) } },
            (err: unknown) => {
              running--
              if (settled) return
              // A failure that is not a timeout is final (a second attempt would get the same refusal). After a timeout the other attempt
              // may still answer, so only the last one standing rejects.
              if (!isRequestTimeout(err)) { done(); reject(err); return }
              if (running > 0) return
              // The only attempt timed out before the hedge delay: it still gets its one more attempt.
              if (started < 2) { policy.onHedge?.({ afterMs: hedgeAfterMs }); start(); return }
              done(); reject(err)
            },
          )
        }
        start()
        timer = setTimeout(() => {
          if (settled || running === 0 || started >= 2) return
          policy.onHedge?.({ afterMs: hedgeAfterMs })
          start()
        }, hedgeAfterMs)
      })
    },
  }
}
