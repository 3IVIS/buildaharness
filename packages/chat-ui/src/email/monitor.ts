import type { Invoke } from './desktop-platform'

/**
 * An opt-in record of what a person does in the Email screen, for a supervised test session (see `mail_monitor.rs`). It is OFF unless the desktop
 * app was started with AIELIA_EMAIL_MONITOR; then every click, typed field, error and a short description of what the screen shows are appended
 * as JSON lines to the file the app was given, so the person running the test can be followed live. Never runs in a browser tab.
 */

export type MonitorLog = (kind: string, data?: Record<string, unknown>) => void
let log: MonitorLog = () => undefined

/** Record one event (a no-op unless the monitor was started). Used by the host for results that are not clicks (a sign of what the app decided). */
export const monitorLog: MonitorLog = (kind, data) => log(kind, data)

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

const nameOf = (el: Element): string => clip(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '', 80)

/** What the screen shows right now, in a few lines: headings, alerts and status text, and the names of the buttons (with which are disabled). */
export function describeScreen(root: ParentNode): { headings: string[]; notices: string[]; buttons: string[]; disabled: string[] } {
  const take = (sel: string, max: number): Element[] => [...root.querySelectorAll(sel)].slice(0, max)
  const buttons = take('button, [role="button"], a[href]', 60)
  return {
    headings: take('h1, h2', 8).map((e) => clip(e.textContent ?? '', 80)),
    notices: take('[role="alert"], [role="status"], [role="note"]', 8).map((e) => clip(e.textContent ?? '', 200)),
    buttons: buttons.map(nameOf).filter(Boolean),
    disabled: buttons.filter((b) => b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true').map(nameOf).filter(Boolean),
  }
}

/** Start recording if the app has the monitor switched on. Returns a stop function, or undefined when it is off. */
export async function startEmailMonitor(invoke: Invoke, doc: Document = document): Promise<(() => void) | undefined> {
  let on = false
  try { on = await invoke<boolean>('email_monitor_enabled') } catch { return undefined }
  if (!on) return undefined
  log = (kind, data) => { void invoke('email_monitor_log', { line: JSON.stringify({ t: new Date().toISOString(), kind, ...(data ?? {}) }) }).catch(() => undefined) }
  const w = doc.defaultView ?? window
  let timer: ReturnType<typeof setTimeout> | undefined
  const snapshot = (why: string): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => log('screen', { why, ...describeScreen(doc) }), 700)
  }
  const onClick = (e: Event): void => {
    const t = (e.target as Element | null)?.closest?.('button, [role="button"], a, summary, select, input, label, li, tr')
    if (!t) return
    log('click', { tag: t.tagName.toLowerCase(), name: nameOf(t) })
    snapshot('click')
  }
  const onChange = (e: Event): void => {
    const t = e.target as HTMLInputElement | HTMLSelectElement | null
    if (!t || t.tagName === 'BUTTON') return
    const type = (t as HTMLInputElement).type
    log('input', { field: nameOf(t) || t.tagName.toLowerCase(), value: type === 'password' ? '(hidden)' : clip(String(t.value ?? ''), 200) })
  }
  const onKey = (e: Event): void => {
    const k = e as KeyboardEvent
    if (k.key === 'Enter') log('key', { key: 'Enter', in: nameOf(k.target as Element) })
  }
  const onError = (e: ErrorEvent): void => log('error', { message: clip(e.message ?? '', 300), at: `${e.filename ?? ''}:${e.lineno ?? ''}` })
  const onRejection = (e: PromiseRejectionEvent): void => log('unhandledrejection', { reason: clip(String((e.reason as { message?: string } | undefined)?.message ?? e.reason), 300) })
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('change', onChange, true)
  doc.addEventListener('keydown', onKey, true)
  w.addEventListener('error', onError)
  w.addEventListener('unhandledrejection', onRejection)
  const originalError = console.error
  console.error = (...a: unknown[]): void => { log('console.error', { text: clip(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '), 300) }); originalError(...a) }
  log('monitor_started', { ua: clip(w.navigator?.userAgent ?? '', 120) })
  snapshot('start')
  return () => {
    doc.removeEventListener('click', onClick, true); doc.removeEventListener('change', onChange, true); doc.removeEventListener('keydown', onKey, true)
    w.removeEventListener('error', onError); w.removeEventListener('unhandledrejection', onRejection); console.error = originalError
    if (timer) clearTimeout(timer)
    log = () => undefined
  }
}
