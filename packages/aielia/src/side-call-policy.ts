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
 * plus a normal response, and each attempt keeps its own hard bound. A failure waits for the other attempt if one is running; after that a
 * transient one (a timeout, 408, 429, 5xx: benchmark scenarios 02, 08 and 10 each ended a classification on "The LLM proxy returned an error")
 * gets one more attempt, while a refusal or a malformed answer would come back the same and is returned at once.
 */
export const SIDE_CALL_HEDGE_AFTER_MS = 25_000
export const SIDE_CALL_TIMEOUT_MS = 120_000

/** A failure worth one more attempt: a request that timed out, or an endpoint status that comes and goes (408, 429, any 5xx). A 4xx refusal or a bad answer is final. */
export function isTransientFailure(err: unknown): boolean {
  if (isRequestTimeout(err)) return true
  const status = typeof err === 'object' && err !== null && typeof (err as { cause?: { status?: unknown } }).cause === 'object'
    ? ((err as { cause?: { status?: unknown } }).cause as { status?: unknown } | null)?.status
    : undefined
  return typeof status === 'number' && (status === 408 || status === 429 || status >= 500)
}

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
              // The other attempt may still answer, so a failure only counts once no attempt is left running.
              if (running > 0) return
              // A transient failure (a timeout, or an error status that comes and goes) gets its one more attempt; anything else is a refusal
              // a second attempt would meet again.
              if (isTransientFailure(err) && started < 2) { policy.onHedge?.({ afterMs: hedgeAfterMs }); start(); return }
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
