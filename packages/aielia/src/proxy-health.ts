import type { DoctorCheck } from './cli-session.js'
import { redactUrlCredentials } from './redact-url.js'

const PROXY_HEALTH_TIMEOUT_MS = 3000

/**
 * GET <proxyUrl>/health, expecting {status:'ok'} (see packages/proxy/src/index.ts), hard-timed so a dead proxy
 * cannot hang /doctor or Settings. Shared by the CLI's /doctor and the apps' Settings diagnostics. Credentials in
 * the URL (user:password, query values) are masked in the label. Only fetch and AbortController, so it is
 * browser-safe; the desktop app can pass Tauri's fetch.
 */
export async function checkProxyHealth(proxyUrl: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<DoctorCheck> {
  const label = `proxy reachable (${redactUrlCredentials(proxyUrl)}/health)`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROXY_HEALTH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${proxyUrl}/health`, { signal: controller.signal })
    if (!res.ok) return { label, ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => undefined)) as { status?: string } | undefined
    return body?.status === 'ok' ? { label, ok: true } : { label, ok: false, detail: 'unexpected response body' }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return { label, ok: false, detail: timedOut ? 'timed out' : err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
  }
}
