/**
 * Langfuse canvas event scaffolding
 *
 * Instruments canvas authoring events (flow opened, node added, flow exported)
 * as Langfuse spans, and links them to live execution traces when a flow is
 * running.
 *
 * Fix #54: events are now queued in memory when the Langfuse endpoint is
 * unavailable, and flushed with exponential-backoff retries.  Events that
 * fail after MAX_RETRIES attempts are dropped with a console warning so
 * observability never affects authoring.
 *
 * Feature-flagged — no-ops when disabled, no network calls.
 * Enable in .env.local:
 *
 *   VITE_LANGFUSE_ENABLED=true
 *   VITE_LANGFUSE_PUBLIC_KEY=pk-lf-...     ← matches your .env LANGFUSE_PUBLIC_KEY
 *   VITE_LANGFUSE_HOST=http://localhost:3001
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED    = import.meta.env.VITE_LANGFUSE_ENABLED === 'true'
const PUBLIC_KEY = import.meta.env.VITE_LANGFUSE_PUBLIC_KEY as string | undefined
const BASE_URL   = (import.meta.env.VITE_LANGFUSE_HOST as string | undefined)
                   ?? 'http://localhost:3001'

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
  | { name: 'flow.run.start'; props: { flowId: string; jobId: string; runtime: string } }
  | { name: 'flow.run.done';  props: { flowId: string; jobId: string; status: string } }

// ─── Internal state ───────────────────────────────────────────────────────────

let _sessionTraceId:   string | null = null
let _executionTraceId: string | null = null

function uuid(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ─── Fix #54: Event queue with retry ─────────────────────────────────────────

interface QueuedEvent {
  payload:  object
  attempts: number
}

const _queue:     QueuedEvent[] = []
const MAX_RETRIES = 3
let   _flushing   = false

async function _flush(): Promise<void> {
  if (_flushing || _queue.length === 0) return
  _flushing = true

  const batch = _queue.splice(0, 10)   // process up to 10 at a time

  try {
    const res = await fetch(`${BASE_URL}/api/public/ingestion`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Basic ${btoa(`${PUBLIC_KEY!}:`)}`,
      },
      body: JSON.stringify({ batch: batch.map((e) => e.payload) }),
    })

    if (!res.ok) {
      // Non-2xx: requeue events that haven't exceeded MAX_RETRIES
      const requeue = batch.filter((e) => e.attempts < MAX_RETRIES)
      requeue.forEach((e) => { e.attempts++; _queue.unshift(e) })
      const dropped = batch.length - requeue.length
      if (dropped > 0) console.warn(`[langfuse] dropped ${dropped} event(s) after ${MAX_RETRIES} attempts`)
    }
  } catch {
    // Network error: requeue with exponential backoff
    const requeue = batch.filter((e) => e.attempts < MAX_RETRIES)
    requeue.forEach((e) => { e.attempts++; _queue.unshift(e) })
    const dropped = batch.length - requeue.length
    if (dropped > 0) console.warn(`[langfuse] dropped ${dropped} event(s) after ${MAX_RETRIES} attempts`)
  } finally {
    _flushing = false
    if (_queue.length > 0) {
      // Exponential backoff: 2s, 4s, 8s for attempts 1, 2, 3.
      const maxAttempts = _queue.reduce((m, e) => Math.max(m, e.attempts), 0)
      const delay = Math.min(2000 * Math.pow(2, maxAttempts - 1), 16000)
      setTimeout(_flush, delay)
    }
  }
}

function _enqueue(payload: object): void {
  _queue.push({ payload, attempts: 0 })
  // Debounce: flush after a short delay to allow batching.
  setTimeout(_flush, 200)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initLangfuse(): void {
  if (!ENABLED) return
  // Guard against double-initialisation (e.g. if called from a useEffect in StrictMode,
  // or manually called twice). A second call would create a second orphaned session trace.
  if (_sessionTraceId) return
  if (!PUBLIC_KEY) {
    console.warn(
      '[langfuse] VITE_LANGFUSE_PUBLIC_KEY is not set.\n' +
      'Add it to .env.local — it should match LANGFUSE_PUBLIC_KEY in your .env.\n' +
      `Langfuse UI: ${BASE_URL}`
    )
    return
  }
  _sessionTraceId = uuid()
  void trackCanvasEvent({ name: 'canvas.session_start' })
  console.debug('[langfuse] session trace started', _sessionTraceId, '→', BASE_URL)
}

export function setActiveExecutionTrace(traceId: string | null): void {
  _executionTraceId = traceId
  if (traceId) {
    console.debug('[langfuse] execution trace active:', traceId)
  }
}

/**
 * Send a canvas event to Langfuse.
 * Fix #54: events are queued instead of silently dropped on network failure.
 * Never throws — observability must not affect authoring.
 */
export async function trackCanvasEvent(event: CanvasEvent): Promise<void> {
  if (!ENABLED || !_sessionTraceId || !PUBLIC_KEY) return

  const spanId  = uuid()
  const payload = {
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
      parentObservationId: _executionTraceId ?? undefined,
    },
  }

  // Fix #54: enqueue instead of fire-and-forget with silent catch.
  _enqueue(payload)
}
