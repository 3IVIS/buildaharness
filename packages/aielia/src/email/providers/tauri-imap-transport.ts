import { EmailProviderError } from '../provider.js'
import { SignInNeededError } from '../token-source.js'
import type { MailInvoke } from '../tauri-mail-client.js'
import type { ImapCommand, ImapTransport } from './imap.js'

/**
 * The page's side of the desktop IMAP and SMTP commands (`mail_imap_run`, `mail_smtp_send`, packages/desktop/src-tauri/
 * src/mail_imap.rs). Rust connects over TLS to the registered host only and logs in with the app password or OAuth
 * token it reads from the keychain: this class passes the user name and the kind of sign-in, never a secret. Takes
 * `invoke` as a parameter; no Tauri or DOM import.
 */
export type ImapAuth = { kind: 'password'; user: string } | { kind: 'oauth'; user: string; provider: 'gmail' | 'graph'; clientId: string }
export interface ServerAddress { host: string; port: number }

/** Map a Rust error string to the provider error codes the rest of Email already handles. */
export function mapImapError(e: unknown): Error {
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : 'unknown error'
  if (text.startsWith('sign_in_needed')) return new SignInNeededError('refresh_rejected', 'sign in again')
  if (text.startsWith('sign_in_failed')) return new EmailProviderError('unauthorized', 'the mail server refused the user name or password')
  if (text.startsWith('host_rejected') || text.startsWith('bad_request')) return new EmailProviderError('invalid_argument', text)
  if (text.startsWith('provider_error')) {
    return new EmailProviderError(/NONEXISTENT|TRYCREATE|no such/i.test(text) ? 'not_found' : /THROTTLE|too many/i.test(text) ? 'rate_limited' : 'unavailable', text)
  }
  return new EmailProviderError('unavailable', text)
}

export class TauriImapTransport implements ImapTransport {
  constructor(
    private readonly invoke: MailInvoke,
    private readonly accountId: string,
    private readonly imap: ServerAddress,
    private readonly smtp: ServerAddress,
    private readonly auth: ImapAuth,
  ) {}

  private authArg(): Record<string, unknown> {
    return this.auth.kind === 'password' ? { kind: 'password', user: this.auth.user } : { kind: 'oauth', user: this.auth.user, provider: this.auth.provider, clientId: this.auth.clientId }
  }

  /** Register both hosts with Rust (it refuses anything that is not a plain host name) before the first call. */
  async registerHosts(): Promise<void> {
    try {
      for (const host of new Set([this.imap.host, this.smtp.host])) await this.invoke('mail_register_host', { accountId: this.accountId, host })
    } catch (e) {
      throw mapImapError(e)
    }
  }

  /** The app password goes to the keychain here and is never readable from the page again. */
  async setPassword(password: string): Promise<void> {
    try {
      await this.invoke('mail_imap_set_password', { accountId: this.accountId, password })
    } catch (e) {
      throw mapImapError(e)
    }
  }

  async run(commands: ImapCommand[]): Promise<string[]> {
    try {
      const r = await this.invoke<{ responses: string[] }>('mail_imap_run', {
        accountId: this.accountId, server: this.imap, auth: this.authArg(), commands: commands.map((c) => ({ command: c.command, literal: c.literal ?? null })),
      })
      return r.responses
    } catch (e) {
      throw mapImapError(e)
    }
  }

  async sendMail(m: { from: string; recipients: string[]; data: string }): Promise<void> {
    try {
      await this.invoke('mail_smtp_send', { accountId: this.accountId, server: this.smtp, auth: this.authArg(), from: m.from, recipients: m.recipients, data: m.data })
    } catch (e) {
      throw mapImapError(e)
    }
  }
}
