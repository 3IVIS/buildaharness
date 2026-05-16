/**
 * Langfuse canvas event scaffolding
 *
 * Instruments canvas authoring events (flow opened, node added, flow exported)
 * as Langfuse spans. Designed to wire into execution traces in Phase 2 once
 * the LangGraph adapter lands.
 *
 * Feature-flagged — no-ops when disabled, no network calls.
 * Enable by adding to .env.local:
 *   VITE_LANGFUSE_ENABLED=true
 *   VITE_LANGFUSE_PUBLIC_KEY=pk-lf-...
 *   VITE_LANGFUSE_HOST=https://cloud.langfuse.com   (optional, defaults to cloud)
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED    = import.meta.env.VITE_LANGFUSE_ENABLED === 'true'
const PUBLIC_KEY = import.meta.env.VITE_LANGFUSE_PUBLIC_KEY as string | undefined
const BASE_URL   = (import.meta.env.VITE_LANGFUSE_HOST as string | undefined)
                   ?? 'https://cloud.langfuse.com'

// ─── Event types ─────────────────────────────────────────────────────────────

export type CanvasEvent =
  | { name: 'canvas.session_start' }
  | { name: 'flow.opened';    props: { flowId: string; flowName: string } }
  | { name: 'flow.new' }
  | { name: 'flow.saved';     props: { flowId: string } }
  | { name: 'flow.exported';  props: { flowId: string; format: 'json' | 'clipboard' } }
  | { name: 'node.added';     props: { nodeType: string; flowId: string } }
  | { name: 'flow.validated'; props: { flowId: string; errorCount: number } }
  | { name: 'flow.compiled';  props: { flowId: string; runtime: string; success: boolean } }

// ─── Internal state ───────────────────────────────────────────────────────────

let _sessionTraceId: string | null = null

function uuid(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once at app startup to create a session trace.
 * No-op when VITE_LANGFUSE_ENABLED != 'true'.
 */
export function initLangfuse(): void {
  if (!ENABLED) return
  if (!PUBLIC_KEY) {
    console.warn(
      '[langfuse] VITE_LANGFUSE_PUBLIC_KEY is not set.\n' +
      'Canvas events will not be tracked until you set it in .env.local.'
    )
    return
  }
  _sessionTraceId = uuid()
  void trackCanvasEvent({ name: 'canvas.session_start' })
  console.debug('[langfuse] session trace started', _sessionTraceId)
}

/**
 * Send a canvas event to Langfuse.
 * Silently no-ops when disabled or when the key is missing.
 * Never throws — observability must not affect authoring.
 */
export async function trackCanvasEvent(event: CanvasEvent): Promise<void> {
  if (!ENABLED || !_sessionTraceId || !PUBLIC_KEY) return

  const spanId = uuid()

  try {
    await fetch(`${BASE_URL}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Langfuse public key auth: key as username, no password
        Authorization: `Basic ${btoa(`${PUBLIC_KEY}:`)}`,
      },
      body: JSON.stringify({
        batch: [
          {
            id:        uuid(),
            type:      'span-create',
            timestamp: new Date().toISOString(),
            body: {
              id:        spanId,
              traceId:   _sessionTraceId,
              name:      event.name,
              input:     'props' in event ? event.props : undefined,
              startTime: new Date().toISOString(),
              endTime:   new Date().toISOString(),
              // Phase 2: wire parentSpanId when an execution trace is active
              // parentObservationId: _activeExecutionSpanId ?? undefined,
            },
          },
        ],
      }),
    })
  } catch {
    // Silently swallow — Langfuse is non-blocking. If the server is down
    // or unreachable (e.g. local dev without Docker Compose running), events
    // are dropped, not buffered. A queue will be added in Phase 2.
  }
}
