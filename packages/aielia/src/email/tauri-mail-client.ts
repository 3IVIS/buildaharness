import { SignInNeededError } from './token-source.js'

/**
 * The page's side of the desktop mail commands (`mail_oauth_sign_in`, `mail_list_folders`, `mail_list_messages`,
 * packages/desktop/src-tauri/src/mail_net.rs). Sign-in, token storage, refresh and every network request happen in
 * Rust, limited to the provider hosts and the mail servers the user configured. This client only asks ("sign in", "list
 * this folder") and receives provider JSON. No token, code or verifier ever crosses this boundary, in either direction.
 * Takes `invoke` as a parameter: no Tauri or DOM import. Errors from Rust are strings with a code prefix.
 */
export type MailInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export type DesktopProvider = 'gmail' | 'graph'

export type DesktopMailErrorCode = 'sign_in_denied' | 'sign_in_failed' | 'host_rejected' | 'network_error' | 'provider_error' | 'token_error' | 'bad_request' | 'unknown'

export class DesktopMailError extends Error {
  constructor(
    public readonly code: DesktopMailErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DesktopMailError'
  }
}

const CODES: DesktopMailErrorCode[] = ['sign_in_denied', 'sign_in_failed', 'host_rejected', 'network_error', 'provider_error', 'token_error', 'bad_request']

/** `sign_in_needed:` becomes the same `SignInNeededError` the rest of Email already handles; the rest keep their code. */
export function mapDesktopMailError(e: unknown): Error {
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : 'unknown error'
  if (text.startsWith('sign_in_needed')) return new SignInNeededError('refresh_rejected', 'sign in again')
  const code = CODES.find((c) => text.startsWith(`${c}:`)) ?? 'unknown'
  return new DesktopMailError(code, text)
}

export class TauriMailClient {
  constructor(
    private readonly invoke: MailInvoke,
    private readonly accountId: string,
    private readonly provider: DesktopProvider,
    private readonly clientId: string,
  ) {}

  private async call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.invoke<T>(command, { accountId: this.accountId, ...args })
    } catch (e) {
      throw mapDesktopMailError(e)
    }
  }

  /** Tell Rust which mail server the user typed in settings; Rust refuses anything that is not a plain host name. */
  registerHost(host: string): Promise<void> {
    return this.call<void>('mail_register_host', { host })
  }

  /** Opens the system browser; resolves when the user finished. The result says only whether it worked. */
  async signIn(): Promise<void> {
    await this.call<{ signed_in: boolean }>('mail_oauth_sign_in', { provider: this.provider, clientId: this.clientId })
  }

  signOut(): Promise<void> {
    return this.call<void>('mail_sign_out', {})
  }

  listFolders(): Promise<unknown> {
    return this.call<unknown>('mail_list_folders', { provider: this.provider, clientId: this.clientId })
  }

  listMessages(folderId: string, opts: { pageToken?: string; limit?: number } = {}): Promise<unknown> {
    return this.call<unknown>('mail_list_messages', {
      provider: this.provider,
      clientId: this.clientId,
      folderId,
      pageToken: opts.pageToken ?? null,
      limit: opts.limit ?? null,
    })
  }
}
