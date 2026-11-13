import type { NetworkPort } from './network.js'
import type { SecretStore } from './secret-store.js'

/**
 * Token sources (section 5). A `TokenSource` returns a valid access token for one account, or throws
 * `SignInNeededError` when the user has to sign in again. Two kinds: a refresh-token source (renews itself through the
 * provider's token endpoint) and a short-lived-only source (an access token with an expiry and no refresh; Google's
 * browser rules are unverified, see section 15 and phase H7). No `node:*`, no DOM imports.
 */

export interface TokenSource {
  getAccessToken(): Promise<string>
}

export class SignInNeededError extends Error {
  constructor(
    public readonly reason: 'expired' | 'refresh_rejected' | 'missing',
    message: string,
  ) {
    super(message)
    this.name = 'SignInNeededError'
  }
}

/** Renew this long before the stated expiry, so a token does not run out mid-request. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000

export interface StoredAccessToken {
  accessToken: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/** Short-lived-only: no refresh path. When expired, the user signs in again. */
export class ShortLivedTokenSource implements TokenSource {
  constructor(
    private readonly accountId: string,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  async save(token: StoredAccessToken): Promise<void> {
    await this.secrets.set(this.accountId, JSON.stringify(token))
  }

  async getAccessToken(): Promise<string> {
    const raw = await this.secrets.get(this.accountId)
    if (!raw) throw new SignInNeededError('missing', 'no token stored for this account')
    let token: StoredAccessToken
    try {
      token = JSON.parse(raw) as StoredAccessToken
    } catch {
      throw new SignInNeededError('missing', 'the stored token is unreadable')
    }
    if (typeof token.accessToken !== 'string' || typeof token.expiresAt !== 'number') {
      throw new SignInNeededError('missing', 'the stored token is unreadable')
    }
    if (this.now() >= token.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      throw new SignInNeededError('expired', 'the access token has expired; sign in again')
    }
    return token.accessToken
  }
}

export interface RefreshTokenSourceOptions {
  accountId: string
  secrets: SecretStore
  network: NetworkPort
  tokenEndpoint: string
  clientId: string
  now?: () => number
}

interface StoredRefreshState {
  refreshToken: string
  accessToken?: string
  expiresAt?: number
}

/** Refresh-token source: keeps the refresh token in the secret store and renews the access token on demand. */
export class RefreshTokenSource implements TokenSource {
  private inflight: Promise<string> | undefined
  private readonly now: () => number

  constructor(private readonly opts: RefreshTokenSourceOptions) {
    this.now = opts.now ?? Date.now
  }

  async save(state: StoredRefreshState): Promise<void> {
    await this.opts.secrets.set(this.opts.accountId, JSON.stringify(state))
  }

  async getAccessToken(): Promise<string> {
    const state = await this.load()
    if (state.accessToken && state.expiresAt !== undefined && this.now() < state.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      return state.accessToken
    }
    // Concurrent callers share one refresh request.
    this.inflight ??= this.refresh(state).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async load(): Promise<StoredRefreshState> {
    const raw = await this.opts.secrets.get(this.opts.accountId)
    if (!raw) throw new SignInNeededError('missing', 'no token stored for this account')
    try {
      const s = JSON.parse(raw) as StoredRefreshState
      if (typeof s.refreshToken !== 'string' || !s.refreshToken) throw new Error('no refresh token')
      return s
    } catch {
      throw new SignInNeededError('missing', 'the stored token is unreadable')
    }
  }

  private async refresh(state: StoredRefreshState): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
      client_id: this.opts.clientId,
    }).toString()
    const res = await this.opts.network({
      url: this.opts.tokenEndpoint,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.status === 400 || res.status === 401) {
      // The grant was revoked or expired: a stored token that no longer works is useless.
      await this.opts.secrets.delete(this.opts.accountId)
      throw new SignInNeededError('refresh_rejected', 'the provider rejected the refresh token; sign in again')
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`token refresh failed with status ${res.status}`)
    }
    let parsed: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown }
    try {
      parsed = JSON.parse(await res.text())
    } catch {
      throw new Error('token endpoint returned an unreadable response')
    }
    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new Error('token endpoint response lacks an access token')
    }
    const next: StoredRefreshState = {
      // Providers may rotate the refresh token.
      refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : state.refreshToken,
      accessToken: parsed.access_token,
      expiresAt: this.now() + parsed.expires_in * 1000,
    }
    await this.save(next)
    return next.accessToken!
  }
}
