import type { NetworkPort } from './network.js'
import type { SecretStore } from './secret-store.js'
import { RefreshTokenSource, ShortLivedTokenSource, SignInNeededError, type TokenSource } from './token-source.js'

/**
 * OAuth authorisation-code flow with PKCE for a browser app (section 5, phase P2). `begin()` builds the consent address
 * and parks the state and verifier in the secret store (the page reloads on redirect, so memory is not enough);
 * `complete()` checks the redirect (state, denial), exchanges the code through the network port and returns a
 * `TokenSource`. The client id and redirect address are passed in from build configuration; nothing is committed here.
 * Tokens and codes never appear in an error message. No `node:*`, no DOM imports (WebCrypto is passed in).
 */

export interface OAuthProviderEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  scopes: string[]
  /** Extra query parameters on the consent address (for example Google's `access_type=offline`). */
  extraAuthParams?: Record<string, string>
}

/** Google's endpoints. `access_type=offline` asks for a refresh token; Google may still return none in a browser (H7). */
export const GOOGLE_OAUTH_ENDPOINTS: OAuthProviderEndpoints = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
}

/** The part of WebCrypto the flow needs. */
export interface OAuthCrypto {
  getRandomValues(array: Uint8Array): Uint8Array
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }
}

export interface OAuthSignInOptions {
  accountId: string
  endpoints: OAuthProviderEndpoints
  /** From build configuration. */
  clientId: string
  /** From build configuration. */
  redirectUri: string
  network: NetworkPort
  secrets: SecretStore
  crypto?: OAuthCrypto
  now?: () => number
}

export type OAuthErrorCode = 'denied' | 'state_mismatch' | 'no_pending_sign_in' | 'bad_redirect' | 'exchange_failed'

export class OAuthError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

interface PendingSignIn {
  state: string
  verifier: string
}

const pendingKey = (accountId: string): string => `oauth-pending:${accountId}`

function base64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).split('+').join('-').split('/').join('_').split('=').join('')
}

function randomToken(crypto: OAuthCrypto, byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string, crypto: OAuthCrypto): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export class OAuthSignIn {
  private readonly crypto: OAuthCrypto
  private readonly now: () => number

  constructor(private readonly opts: OAuthSignInOptions) {
    this.crypto = opts.crypto ?? (globalThis as unknown as { crypto: OAuthCrypto }).crypto
    this.now = opts.now ?? Date.now
  }

  /** Start a sign-in: returns the address to send the browser to. */
  async begin(): Promise<{ authorizationUrl: string }> {
    const pending: PendingSignIn = { state: randomToken(this.crypto, 24), verifier: randomToken(this.crypto, 48) }
    await this.opts.secrets.set(pendingKey(this.opts.accountId), JSON.stringify(pending))
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: this.opts.endpoints.scopes.join(' '),
      state: pending.state,
      code_challenge: await pkceChallenge(pending.verifier, this.crypto),
      code_challenge_method: 'S256',
      ...this.opts.endpoints.extraAuthParams,
    })
    return { authorizationUrl: `${this.opts.endpoints.authorizationEndpoint}?${params.toString()}` }
  }

  /** Finish a sign-in from the address the browser was redirected to. */
  async complete(redirectUrl: string): Promise<TokenSource> {
    const key = pendingKey(this.opts.accountId)
    const raw = await this.opts.secrets.get(key)
    // One attempt per begin(): the pending record is consumed whatever happens next.
    await this.opts.secrets.delete(key)
    if (!raw) throw new OAuthError('no_pending_sign_in', 'no sign-in is in progress')
    let pending: PendingSignIn
    try {
      pending = JSON.parse(raw) as PendingSignIn
    } catch {
      throw new OAuthError('no_pending_sign_in', 'no sign-in is in progress')
    }

    const q = redirectQuery(redirectUrl)
    if (q.get('state') !== pending.state) throw new OAuthError('state_mismatch', 'the sign-in response did not match this sign-in')
    if (q.get('error')) throw new OAuthError('denied', 'sign-in was not completed (access denied or cancelled)')
    const code = q.get('code')
    if (!code) throw new OAuthError('bad_redirect', 'the sign-in response carried no code')

    const res = await this.opts.network({
      url: this.opts.endpoints.tokenEndpoint,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        client_id: this.opts.clientId,
        redirect_uri: this.opts.redirectUri,
      }).toString(),
    })
    if (res.status < 200 || res.status >= 300) throw new OAuthError('exchange_failed', `token exchange failed with status ${res.status}`)
    let parsed: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown }
    try {
      parsed = JSON.parse(await res.text())
    } catch {
      throw new OAuthError('exchange_failed', 'token endpoint returned an unreadable response')
    }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token || typeof parsed.expires_in !== 'number') {
      throw new OAuthError('exchange_failed', 'token endpoint response lacks an access token')
    }
    const expiresAt = this.now() + parsed.expires_in * 1000
    if (typeof parsed.refresh_token === 'string' && parsed.refresh_token) {
      const source = new RefreshTokenSource({
        accountId: this.opts.accountId,
        secrets: this.opts.secrets,
        network: this.opts.network,
        tokenEndpoint: this.opts.endpoints.tokenEndpoint,
        clientId: this.opts.clientId,
        now: this.now,
      })
      await source.save({ refreshToken: parsed.refresh_token, accessToken: parsed.access_token, expiresAt })
      return source
    }
    // No refresh token: a short-lived source; when it expires the user signs in again.
    const source = new ShortLivedTokenSource(this.opts.accountId, this.opts.secrets, this.now)
    await source.save({ accessToken: parsed.access_token, expiresAt })
    return source
  }

  /**
   * The token source for an account that already signed in. Reads what is stored: a refresh token gives a
   * `RefreshTokenSource`, otherwise a `ShortLivedTokenSource`; nothing stored throws `SignInNeededError`.
   */
  async tokenSource(): Promise<TokenSource> {
    const raw = await this.opts.secrets.get(this.opts.accountId)
    if (!raw) throw new SignInNeededError('missing', 'no token stored for this account')
    let hasRefresh = false
    try {
      hasRefresh = typeof (JSON.parse(raw) as { refreshToken?: unknown }).refreshToken === 'string'
    } catch {
      throw new SignInNeededError('missing', 'the stored token is unreadable')
    }
    if (hasRefresh) {
      return new RefreshTokenSource({
        accountId: this.opts.accountId,
        secrets: this.opts.secrets,
        network: this.opts.network,
        tokenEndpoint: this.opts.endpoints.tokenEndpoint,
        clientId: this.opts.clientId,
        now: this.now,
      })
    }
    return new ShortLivedTokenSource(this.opts.accountId, this.opts.secrets, this.now)
  }
}

/** Query parameters of a redirect address; a code flow answers in the query, and a fragment is read as a fallback. */
function redirectQuery(redirectUrl: string): URLSearchParams {
  const hashAt = redirectUrl.indexOf('#')
  const beforeHash = hashAt === -1 ? redirectUrl : redirectUrl.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')
  if (queryAt !== -1) return new URLSearchParams(beforeHash.slice(queryAt + 1))
  if (hashAt !== -1) return new URLSearchParams(redirectUrl.slice(hashAt + 1))
  throw new OAuthError('bad_redirect', 'the sign-in response carried no parameters')
}
