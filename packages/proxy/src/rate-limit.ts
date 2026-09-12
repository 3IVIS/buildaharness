/**
 * In-memory quota + observability primitives for /web/* routes (W4 of
 * plans/browser_web_tools_via_proxy_plan.html — the plan's own successor to the W1-W3 SSRF-guard
 * + signed-URL-capability work).
 *
 * Single-instance, fixed-window counters — state lives in module-level Maps, so it is NOT shared
 * across multiple Worker isolates or multiple Node processes behind a load balancer. That matches
 * the plan's own scope note ("Node: an in-memory token-bucket with an optional Redis backend for
 * multi-instance"); the route logic that calls into this module doesn't care which store backs
 * it, so swapping in a Durable Object / KV / Redis-backed store later is a change local to this
 * file.
 */

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
  remaining: number
}

interface Window {
  count: number
  windowStart: number
}

/** Fixed-window counter: at most `limit` cost-units per `windowMs`, keyed by an arbitrary string. */
export class WindowCounter {
  private windows = new Map<string, Window>()

  /** Attempts to consume `cost` units against `key`'s window, creating/rolling the window as needed. */
  consume(key: string, cost: number, limit: number, windowMs: number, now: number = Date.now()): RateLimitResult {
    let w = this.windows.get(key)
    if (!w || now - w.windowStart >= windowMs) {
      w = { count: 0, windowStart: now }
      this.windows.set(key, w)
    }
    const retryAfterSeconds = Math.max(0, Math.ceil((w.windowStart + windowMs - now) / 1000))
    if (w.count + cost > limit) {
      return { allowed: false, retryAfterSeconds, remaining: Math.max(0, limit - w.count) }
    }
    w.count += cost
    return { allowed: true, retryAfterSeconds, remaining: Math.max(0, limit - w.count) }
  }

  /**
   * Read-only check against a cumulative quota without consuming anything — used to preemptively
   * reject a request once a prior call already pushed the running total (e.g. bytes/hour) at or
   * past the ceiling, without needing to know this request's cost in advance.
   */
  peek(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitResult {
    const w = this.windows.get(key)
    if (!w || now - w.windowStart >= windowMs) return { allowed: true, retryAfterSeconds: 0, remaining: limit }
    const retryAfterSeconds = Math.max(0, Math.ceil((w.windowStart + windowMs - now) / 1000))
    return { allowed: w.count < limit, retryAfterSeconds, remaining: Math.max(0, limit - w.count) }
  }

  /** Current count in `key`'s active window (0 if none, or if the window has rolled over). */
  currentCount(key: string, windowMs: number, now: number = Date.now()): number {
    const w = this.windows.get(key)
    if (!w || now - w.windowStart >= windowMs) return 0
    return w.count
  }

  reset(): void {
    this.windows.clear()
  }
}

/** Tracks in-flight counts per key (e.g. concurrent /web/fetch calls for one JWT `sub`). */
export class ConcurrencyTracker {
  private counts = new Map<string, number>()

  acquire(key: string, max: number): boolean {
    const current = this.counts.get(key) ?? 0
    if (current >= max) return false
    this.counts.set(key, current + 1)
    return true
  }

  release(key: string): void {
    const current = this.counts.get(key) ?? 0
    if (current <= 1) this.counts.delete(key)
    else this.counts.set(key, current - 1)
  }

  reset(): void {
    this.counts.clear()
  }
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export const requestCounter = new WindowCounter()
export const byteCounter = new WindowCounter()
export const hostCounter = new WindowCounter()
export const ipRequestCounter = new WindowCounter()
export const braveDailyCounter = new WindowCounter()
export const guardRejectCounter = new WindowCounter()
export const grantCounter = new WindowCounter()
export const fetchConcurrency = new ConcurrencyTracker()

/**
 * Test-only: clears all module-level quota/concurrency/log state. Vitest isolates module state
 * per test *file*, not per `it()` block, and most /web/* suites reuse the same JWT `sub` ('runtime',
 * since /auth/token always signs that subject) across many calls in one file — without a reset
 * between tests, quota state from an earlier test in the file would bleed into a later one.
 */
export function resetWebRateLimitState(): void {
  requestCounter.reset()
  byteCounter.reset()
  hostCounter.reset()
  ipRequestCounter.reset()
  braveDailyCounter.reset()
  guardRejectCounter.reset()
  grantCounter.reset()
  fetchConcurrency.reset()
}

export interface WebRateLimitConfig {
  requestsPerHour: number
  bytesPerHour: number
  maxConcurrentFetches: number
  hostRequestsPerHour: number
  ipRequestsPerHour: number
  braveDailyCeiling: number
  grantRequestsPerHour: number
  guardRejectAlertThreshold: number
}

const DEFAULTS: WebRateLimitConfig = {
  requestsPerHour: 120,
  bytesPerHour: 2_000_000,
  maxConcurrentFetches: 4,
  hostRequestsPerHour: 60,
  ipRequestsPerHour: 30,
  braveDailyCeiling: 2000,
  grantRequestsPerHour: 20,
  guardRejectAlertThreshold: 5,
}

function envInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name] ?? process.env[name]
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function getWebRateLimitConfig(env: Record<string, string | undefined>): WebRateLimitConfig {
  return {
    requestsPerHour: envInt(env, 'WEB_REQUESTS_PER_HOUR', DEFAULTS.requestsPerHour),
    bytesPerHour: envInt(env, 'WEB_BYTES_PER_HOUR', DEFAULTS.bytesPerHour),
    maxConcurrentFetches: envInt(env, 'WEB_MAX_CONCURRENT_FETCHES', DEFAULTS.maxConcurrentFetches),
    hostRequestsPerHour: envInt(env, 'WEB_HOST_REQUESTS_PER_HOUR', DEFAULTS.hostRequestsPerHour),
    ipRequestsPerHour: envInt(env, 'WEB_PER_IP_REQUESTS_PER_HOUR', DEFAULTS.ipRequestsPerHour),
    braveDailyCeiling: envInt(env, 'WEB_BRAVE_DAILY_CEILING', DEFAULTS.braveDailyCeiling),
    grantRequestsPerHour: envInt(env, 'WEB_GRANT_REQUESTS_PER_HOUR', DEFAULTS.grantRequestsPerHour),
    guardRejectAlertThreshold: envInt(env, 'WEB_GUARD_REJECT_ALERT_THRESHOLD', DEFAULTS.guardRejectAlertThreshold),
  }
}

/** Best-effort client IP from the headers a reverse proxy / Cloudflare would set; 'unknown' if none are present (never blocks solely for being unknown). */
export function clientIp(headers: { get(name: string): string | null }): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

export interface WebLogEntry {
  ts: string
  sub: string
  route: string
  host?: string
  status: number
  bytes?: number
  guardRejectReason?: string
}

/** Structured, single-line JSON log for a /web/* call — deliberately never includes the query text or request/response body. */
export function logWebRequest(entry: WebLogEntry): void {
  console.log(JSON.stringify(entry))
}

/**
 * Records a guard rejection (SSRF-guard / tag / content-type failure) for `sub` and logs an
 * "alert" line once repeated rejections cross `threshold` within an hour — a cheap signal for
 * "someone is probing the SSRF guard with private-range targets", not itself a block.
 */
export function recordGuardRejection(sub: string, threshold: number, now: number = Date.now()): void {
  const key = `sub:${sub}`
  guardRejectCounter.consume(key, 1, Number.MAX_SAFE_INTEGER, HOUR_MS, now)
  const count = guardRejectCounter.currentCount(key, HOUR_MS, now)
  if (count === threshold) {
    console.warn(JSON.stringify({ ts: new Date(now).toISOString(), alert: 'repeated_guard_rejections', sub, count, windowMs: HOUR_MS }))
  }
}
