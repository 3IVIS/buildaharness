import { cleanConnection, type WriteConnection } from '../write/write-config'

/**
 * Email's own model connection. Email runs on its own origin (decision 2), so it never reads the Chat or Write key: the key is entered here on first
 * run and kept in this browser only. The shape is Write's (OpenRouter first), stored under Email's own key.
 */
export type EmailConnection = WriteConnection

const STORAGE_KEY = 'aielia-email.connection'

export function loadEmailConnection(): EmailConnection | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? cleanConnection(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

export function saveEmailConnection(c: EmailConnection): void {
  const cleaned = cleanConnection(c)
  if (!cleaned) return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned)) } catch (err) { console.warn('localStorage is unavailable — the connection will not persist.', err) }
}

export function clearEmailConnection(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* nothing stored that could be removed */ }
}

/** The steps of first run, in order. With no mail account the app opens the sample mailbox instead (the steps stay one click away). */
export type FirstRunStep = 'account' | 'ai' | 'ready'

export interface FirstRunState {
  /** A mail account is connected. */
  account: boolean
  /** A model connection is saved. */
  connection: boolean
}

/** Which step is next: the mail account first, then the AI, then the app. */
export function nextFirstRunStep(s: FirstRunState): FirstRunStep {
  if (!s.account) return 'account'
  if (!s.connection) return 'ai'
  return 'ready'
}
