/**
 * Full-conversation capture for a benchmark arm — Plan A1
 * (plans/feature_audit_automation_plan.html).
 *
 * The benchmark historically kept only a 500-char `replyPreview` per row, so a published audit
 * number had no evidence trail. This module records every LLM request/response, every tool call,
 * and the arm's trace/debug streams into one time-ordered `TranscriptEvent[]` per run, which the
 * runner writes to disk when a `transcriptDir` is set (see runner.ts) and A2's page generator
 * turns into browsable HTML.
 *
 * Contract:
 *   - `wrapRecordingClient(inner)` returns a transparent `ILLMClient` proxy — the wrapped call
 *     behaves identically (same return value, same streamed chunks, caller callbacks still fire).
 *   - `drain()` is idempotent: it returns a time-sorted copy of everything recorded so far and
 *     never clears the buffer.
 *   - Every recorded string is run through `scrubSecrets()` first — the corpus is synthetic, but
 *     a planted key/token shape must never reach a published page (cross-cutting rule 3).
 */
import type {
  ILLMClient,
  ChatMessage,
  ChatOptions,
  ToolDefinition,
  LLMStructuredResponse,
  TokenUsage,
} from '@buildaharness/runtime'

export type TranscriptEventKind = 'llm_request' | 'llm_response' | 'tool_call' | 'trace' | 'debug'

export interface TranscriptEvent {
  /** ms epoch — the merge key across the LLM / trace / debug source streams. */
  t: number
  kind: TranscriptEventKind
  dir?: 'req' | 'res'
  /** llm_request / llm_response: the model alias or id in play, when the caller passed one. */
  model?: string
  /** llm_request: the messages sent (scrubbed). */
  messages?: { role: string; content: string; toolCalls?: unknown[] }[]
  /** llm_response: the reply text (scrubbed). */
  reply?: string
  /** llm_response / tool_call: structured tool calls. */
  toolCalls?: { id?: string; name: string; input: Record<string, unknown> }[]
  /** llm_response: token usage as the backend reported it. */
  usage?: TokenUsage
  /** tool_call: the resolved tool name / input / result text (scrubbed). */
  tool?: string
  input?: Record<string, unknown>
  result?: string
  /** trace: the raw TraceEvent. debug: the DebugLogEntry kind. */
  detail?: unknown
}

/** Common secret shapes — redacted before a string is ever recorded or written. */
const SECRET_PATTERNS: { re: RegExp; replace: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{12,}/g, replace: '[redacted]' },
  { re: /sk-[A-Za-z0-9_-]{16,}/g, replace: '[redacted]' },
  { re: /gh[oprsu]_[A-Za-z0-9]{20,}/g, replace: '[redacted]' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, replace: '[redacted]' },
  { re: /AKIA[0-9A-Z]{16}/g, replace: '[redacted]' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[redacted]' },
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '[redacted]' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '[redacted]' },
  // key=value / "token": "..." style — keep the label, drop the value.
  { re: /\b(api[_-]?key|secret|password|token|authorization|bearer)(["'\s:=]{1,4})([A-Za-z0-9._-]{16,})/gi, replace: '$1$2[redacted]' },
  // Email addresses — the corpus is synthetic, so any email in a transcript is either fixture
  // data (redacting it is harmless) or ambient PII the model pulled in from the CLI's own account
  // context (e.g. "check your email (you@example.com)"). Redact before anything is published.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[redacted-email]' },
]

export function scrubSecrets(text: string): string {
  let out = text
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace)
  return out
}

function scrubMessages(messages: ChatMessage[]): TranscriptEvent['messages'] {
  return messages.map((m) => ({
    role: m.role,
    content: scrubSecrets(m.content ?? ''),
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
  }))
}

/** Wraps `options` so a usage callback taps into `sink` without disturbing the caller's own. */
function withUsageTap(options: ChatOptions | undefined, sink: TokenUsage[]): ChatOptions {
  return {
    ...options,
    onUsage: (u) => {
      sink.push(u)
      options?.onUsage?.(u)
    },
  }
}

export interface RecordingClient {
  client: ILLMClient
  /** Time-sorted copy of everything recorded so far. Idempotent — never clears. */
  drain(): TranscriptEvent[]
}

export function wrapRecordingClient(inner: ILLMClient, opts: { model?: string } = {}): RecordingClient {
  const events: TranscriptEvent[] = []
  const model = opts.model

  const client: ILLMClient = {
    async *callChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
      events.push({ t: Date.now(), kind: 'llm_request', dir: 'req', model: options?.model ?? model, messages: scrubMessages(messages) })
      let acc = ''
      for await (const chunk of inner.callChat(messages, options)) {
        acc += chunk
        yield chunk
      }
      events.push({ t: Date.now(), kind: 'llm_response', dir: 'res', model: options?.model ?? model, reply: scrubSecrets(acc) })
    },

    async callChatSync(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
      events.push({ t: Date.now(), kind: 'llm_request', dir: 'req', model: options?.model ?? model, messages: scrubMessages(messages) })
      const usage: TokenUsage[] = []
      const reply = await inner.callChatSync(messages, withUsageTap(options, usage))
      events.push({ t: Date.now(), kind: 'llm_response', dir: 'res', model: options?.model ?? model, reply: scrubSecrets(reply), usage: usage.at(-1) })
      return reply
    },

    async callChatStructured(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      options?: ChatOptions,
    ): Promise<LLMStructuredResponse> {
      events.push({ t: Date.now(), kind: 'llm_request', dir: 'req', model: options?.model ?? model, messages: scrubMessages(messages) })
      const usage: TokenUsage[] = []
      const res = await inner.callChatStructured(messages, tools, withUsageTap(options, usage))
      events.push({
        t: Date.now(),
        kind: 'llm_response',
        dir: 'res',
        model: options?.model ?? model,
        reply: scrubSecrets(res.content ?? ''),
        ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
        usage: usage.at(-1),
      })
      return res
    },
  }

  return {
    client,
    drain: () => events.slice().sort((a, b) => a.t - b.t),
  }
}

/** Fold N already-collected event streams into one time-ordered transcript. Stable sort by `t`. */
export function mergeTranscriptEvents(...streams: TranscriptEvent[][]): TranscriptEvent[] {
  return streams
    .flat()
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
    .map(({ e }) => e)
}

/** A trace-stream event (arm `onTrace`) as a transcript entry. */
export function traceEvent(detail: unknown): TranscriptEvent {
  return { t: Date.now(), kind: 'trace', detail }
}

/** A debug-log entry (arm `onDebugLog` — the one hook carrying real tool content) as a transcript entry. */
export function debugEvent(entry: { kind: string; content: string }): TranscriptEvent {
  return { t: Date.now(), kind: 'debug', tool: entry.kind, result: scrubSecrets(entry.content) }
}
