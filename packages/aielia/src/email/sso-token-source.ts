import { SignInNeededError, TOKEN_EXPIRY_SKEW_MS, type TokenSource } from './token-source.js'

/**
 * Single sign-on for Microsoft accounts through the operating system (plans/aielia_email_capabilities_plan.html, section 8, D5): on a Mac set up
 * with the Microsoft broker, or on Windows signed in with a Microsoft account, an access token for Microsoft Graph can be had silently, so the user
 * does not type a password again. The token is held in memory only. The operating-system side is a `SsoBroker`, implemented by the desktop app
 * over Rust commands; this build ships the interface and a Rust stub that reports "not built", so the option never appears until the broker exists.
 * No `node:*` and no DOM imports.
 */

export type SsoUnavailableReason = 'not_built' | 'unsupported_platform' | 'no_broker' | 'not_signed_in' | 'policy'

export type SsoAvailability = { available: true; account?: { name?: string; address?: string } } | { available: false; reason: SsoUnavailableReason }

export interface SsoRequest { scopes: string[]; accountHint?: string }
export interface SsoToken { accessToken: string; /** Epoch milliseconds. */ expiresAt: number }

export class SsoInteractionRequired extends Error {
  constructor(message = 'the operating system needs the user to sign in') {
    super(message)
    this.name = 'SsoInteractionRequired'
  }
}

export interface SsoBroker {
  availability(): Promise<SsoAvailability>
  /** A token without showing anything to the user. Throws `SsoInteractionRequired` when that is not possible. */
  acquireSilently(req: SsoRequest): Promise<SsoToken>
}

/** Microsoft Graph scopes for reading and organising mail (never sending: drafts only). */
export const GRAPH_MAIL_SCOPES: readonly string[] = ['https://graph.microsoft.com/Mail.ReadWrite', 'offline_access']

export interface SsoTokenSourceOptions extends SsoRequest { now?: () => number }

/**
 * A `TokenSource` over the broker. A token is reused until shortly before it expires; when the broker cannot answer silently the caller gets the
 * `SignInNeededError` the rest of Email already handles, so the user is sent to the ordinary sign-in instead of a dead end.
 */
export function ssoTokenSource(broker: SsoBroker, opts: SsoTokenSourceOptions): TokenSource {
  const now = opts.now ?? Date.now
  let cached: SsoToken | undefined
  let inflight: Promise<string> | undefined
  return {
    async getAccessToken(): Promise<string> {
      if (cached && now() < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS) return cached.accessToken
      inflight ??= (async () => {
        try {
          const t = await broker.acquireSilently({ scopes: opts.scopes, ...(opts.accountHint ? { accountHint: opts.accountHint } : {}) })
          if (typeof t.accessToken !== 'string' || !t.accessToken || typeof t.expiresAt !== 'number') throw new SignInNeededError('missing', 'the system gave no usable token')
          cached = t
          return t.accessToken
        } catch (e) {
          cached = undefined
          if (e instanceof SignInNeededError) throw e
          if (e instanceof SsoInteractionRequired) throw new SignInNeededError('expired', 'sign in again')
          throw new SignInNeededError('missing', e instanceof Error ? e.message : 'single sign-on failed')
        } finally {
          inflight = undefined
        }
      })()
      return inflight
    },
  }
}

export type SsoInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/** The broker over the desktop commands `mail_sso_availability` and `mail_sso_acquire`. Rust holds the token request; no secret is kept by the page. */
export function tauriSsoBroker(invoke: SsoInvoke): SsoBroker {
  return {
    async availability() {
      try { return await invoke<SsoAvailability>('mail_sso_availability') } catch { return { available: false, reason: 'not_built' } }
    },
    async acquireSilently(req) {
      try {
        return await invoke<SsoToken>('mail_sso_acquire', { scopes: req.scopes, accountHint: req.accountHint ?? null })
      } catch (e) {
        const text = typeof e === 'string' ? e : e instanceof Error ? e.message : ''
        if (text.startsWith('interaction_required')) throw new SsoInteractionRequired()
        throw e instanceof Error ? e : new Error(text || 'single sign-on failed')
      }
    },
  }
}
