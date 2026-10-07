import { FlowExecutionError } from './errors'

/**
 * How long one wait on a model endpoint may take before the call fails: the response headers, a whole non-streamed body,
 * or the gap between two streamed chunks. A request that stalls (benchmark scenario 10: a turn sat in "Working…" for 20
 * minutes after its reply, and the next message stayed queued) otherwise blocks the turn forever, since fetch has no
 * timeout of its own. Generous because a non-streamed structured reply is generated in full before it arrives.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/** Settles with `promise`, or rejects with a FlowExecutionError after `ms`; `onTimeout` lets the caller abort the request. */
export function withRequestTimeout<T>(promise: Promise<T>, ms: number, nodeId: string, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new FlowExecutionError({ nodeId, message: `LLM request timed out after ${Math.round(ms / 1000)}s ${what}`, cause: { timeout: true } }))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
