export interface ErrorClassification {
  message: string
  retryable: boolean
}

interface ErrorPattern {
  test: (err: unknown) => boolean
  classify: (err: unknown) => ErrorClassification
}

const hasCode = (err: unknown, code: string): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code

const hasName = (err: unknown, name: string): boolean =>
  err instanceof Error && err.name === name

const messageIncludes = (err: unknown, needle: string): boolean =>
  err instanceof Error && err.message.toLowerCase().includes(needle)

// Ordered most-specific first — the first matching pattern wins.
const ERROR_PATTERNS: ErrorPattern[] = [
  {
    // node:child_process ENOENT — the `claude` binary isn't on PATH / CLAUDE_PATH is wrong.
    test: (err) => hasCode(err, 'ENOENT'),
    classify: () => ({
      message: "Couldn't find the Claude CLI. Check that `claude` is on your PATH, or set CLAUDE_PATH.",
      retryable: false,
    }),
  },
  {
    // @buildaharness/runtime's FlowExecutionError, thrown by LLMClient on a non-2xx proxy response.
    test: (err) => hasName(err, 'FlowExecutionError') && typeof (err as { cause?: unknown }).cause === 'object',
    classify: (err) => {
      const status = (err as { cause?: { status?: number } }).cause?.status
      if (status === 401 || status === 403) {
        return { message: 'The LLM proxy rejected the request — check ASSISTANT_PROXY_TOKEN.', retryable: false }
      }
      if (typeof status === 'number' && status >= 500) {
        return { message: 'The LLM proxy is temporarily unavailable. Try again in a moment.', retryable: true }
      }
      return { message: 'The LLM proxy returned an error. Try again in a moment.', retryable: true }
    },
  },
  {
    // Node's undici and browser fetch both throw a generic TypeError when the
    // proxy isn't reachable at all (connection refused, DNS failure, offline).
    test: (err) => messageIncludes(err, 'fetch failed') || messageIncludes(err, 'failed to fetch') || messageIncludes(err, 'networkerror'),
    classify: () => ({
      message: "Couldn't reach the LLM proxy. Check it's running and try again.",
      retryable: true,
    }),
  },
]

/** Maps a thrown turn error to user-facing copy and whether retrying is worth offering. Defaults to a generic, still-retryable message for anything unrecognized. */
export function classifyError(err: unknown): ErrorClassification {
  for (const { test, classify } of ERROR_PATTERNS) {
    if (test(err)) return classify(err)
  }
  return { message: 'Something went wrong. Try again in a moment.', retryable: true }
}
