import type { AssistantConfig } from './config.js'

export interface ErrorClassification {
  message: string
  retryable: boolean
}

interface ErrorPattern {
  test: (err: unknown) => boolean
  classify: (err: unknown, backend: AssistantConfig['llmBackend'] | undefined) => ErrorClassification
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
    // @buildaharness/runtime's FlowExecutionError — thrown both by LLMClient on a non-2xx proxy
    // response AND by AnthropicLLMClient/OpenAICompatibleLLMClient (same runtime package, same
    // error shape) on a non-2xx direct-API response. A 401/403 here means "the proxy's bearer
    // token is wrong" only when llmBackend is actually 'proxy' — for 'anthropic'/'openai'/
    // 'openrouter' it means the user's own apiKey is wrong, and telling them to check
    // ASSISTANT_PROXY_TOKEN instead sends them down the wrong troubleshooting path entirely.
    // Found live: llmBackend=anthropic with a fake apiKey surfaced this exact proxy-token
    // message despite AnthropicLLMClient never touching the proxy.
    test: (err) => hasName(err, 'FlowExecutionError') && typeof (err as { cause?: unknown }).cause === 'object',
    classify: (err, backend) => {
      const status = (err as { cause?: { status?: number } }).cause?.status
      const isDirectApiBackend = backend === 'anthropic' || backend === 'openai' || backend === 'openrouter'
      if (status === 401 || status === 403) {
        return isDirectApiBackend
          ? { message: `The ${backend} API rejected the request — check your apiKey.`, retryable: false }
          : { message: 'The LLM proxy rejected the request — check ASSISTANT_PROXY_TOKEN.', retryable: false }
      }
      if (typeof status === 'number' && status >= 500) {
        return isDirectApiBackend
          ? { message: `The ${backend} API is temporarily unavailable. Try again in a moment.`, retryable: true }
          : { message: 'The LLM proxy is temporarily unavailable. Try again in a moment.', retryable: true }
      }
      return isDirectApiBackend
        ? { message: `The ${backend} API returned an error. Try again in a moment.`, retryable: true }
        : { message: 'The LLM proxy returned an error. Try again in a moment.', retryable: true }
    },
  },
  {
    // Node's undici and browser fetch both throw a generic TypeError when the
    // proxy isn't reachable at all (connection refused, DNS failure, offline).
    test: (err) => messageIncludes(err, 'fetch failed') || messageIncludes(err, 'failed to fetch') || messageIncludes(err, 'networkerror'),
    classify: (_err, backend) => {
      const isDirectApiBackend = backend === 'anthropic' || backend === 'openai' || backend === 'openrouter'
      return isDirectApiBackend
        ? { message: `Couldn't reach the ${backend} API. Check your network and try again.`, retryable: true }
        : { message: "Couldn't reach the LLM proxy. Check it's running and try again.", retryable: true }
    },
  },
]

const MAX_FALLBACK_DETAIL_CHARS = 300

/**
 * invokeClaude/invokeClaudeStreaming (claude-cli-llm-client.ts) reject with `new
 * Error(stderr.trim() || ...)` on any non-zero `claude -p` exit — a real, often-actionable
 * reason (rate limited, auth expired, etc.) that none of ERROR_PATTERNS above recognizes by
 * shape. Previously the fallback below discarded it entirely, always printing the exact same
 * "Something went wrong" with no way to tell one failure cause from another — confirmed live:
 * a `claude -p` exiting non-zero with a specific stderr message surfaced as this fully generic
 * text. Folding in the underlying message (truncated — stderr is unbounded) keeps the fallback
 * a fallback (still no dedicated pattern/retryable judgment for it) while no longer hiding the
 * one piece of information that might explain why.
 */
function fallbackDetail(err: unknown): string {
  if (!(err instanceof Error) || !err.message) return ''
  const detail = err.message.length > MAX_FALLBACK_DETAIL_CHARS ? `${err.message.slice(0, MAX_FALLBACK_DETAIL_CHARS)}…` : err.message
  return ` (${detail})`
}

/**
 * Maps a thrown turn error to user-facing copy and whether retrying is worth offering. Defaults
 * to a generic, still-retryable message for anything unrecognized. `backend` (the caller's
 * current `config.llmBackend`) disambiguates errors whose shape is identical across backends but
 * whose actual cause/remedy differs — see the FlowExecutionError pattern's comment above; omit it
 * only when no backend context exists (e.g. classifying a local file-write error).
 */
export function classifyError(err: unknown, backend?: AssistantConfig['llmBackend']): ErrorClassification {
  for (const { test, classify } of ERROR_PATTERNS) {
    if (test(err)) return classify(err, backend)
  }
  return { message: `Something went wrong${fallbackDetail(err)}. Try again in a moment.`, retryable: true }
}
