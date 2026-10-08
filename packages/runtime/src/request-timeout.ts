import { FlowExecutionError } from './errors'

/**
 * How long one wait on a model endpoint may take before the call fails: the response headers, a whole non-streamed body,
 * or the gap between two streamed chunks. Node's own fetch already ends a silent request after about 300 s
 * (UND_ERR_HEADERS_TIMEOUT), but a webview or browser fetch has no such limit, and 300 s is far too long for the small JSON
 * side calls a turn makes before and after its reply: in the benchmark a turn sat in "Working…" for minutes (scenario 06:
 * 5 min 41 s, scenario 13: 13 min 27 s) while such calls stalled one after another. So the bound is explicit and settable,
 * and shorter for structured side calls.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/** Default bound for a structuredOutput call: a small JSON reply that a healthy endpoint returns in seconds (about 10-25 s for a reasoning model, more under load), so 120 s still ends a real stall. */
export const DEFAULT_STRUCTURED_REQUEST_TIMEOUT_MS = 120_000

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

/** True for the error withRequestTimeout rejects with (its `cause` is `{ timeout: true }`): a request that stalled, as opposed to one the endpoint refused. A stalled request is worth asking again; a refused one is not. */
export function isRequestTimeout(err: unknown): boolean {
  return err instanceof FlowExecutionError && typeof err.cause === 'object' && err.cause !== null && (err.cause as { timeout?: unknown }).timeout === true
}
