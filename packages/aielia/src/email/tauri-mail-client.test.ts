import { describe, it, expect } from 'vitest'
import { TauriMailClient, DesktopMailError, type MailInvoke } from './tauri-mail-client.js'
import { SignInNeededError } from './token-source.js'

function client(handler: (command: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  const invoke: MailInvoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args })
    const r = handler(command, args)
    if (r instanceof Error) throw r.message
    return r as T
  }
  return { c: new TauriMailClient(invoke, 'acct-1', 'gmail', 'client-id-1'), calls }
}

describe('TauriMailClient', () => {
  it('asks Rust for sign-in and reads with the account id and no secret of its own', async () => {
    const { c, calls } = client((cmd) => (cmd === 'mail_oauth_sign_in' ? { signed_in: true } : { labels: [] }))
    await c.signIn()
    await c.listFolders()
    await c.listMessages('INBOX', { limit: 10 })
    expect(calls.map((x) => x.command)).toEqual(['mail_oauth_sign_in', 'mail_list_folders', 'mail_list_messages'])
    for (const x of calls) {
      expect(x.args.accountId).toBe('acct-1')
      expect(Object.keys(x.args).some((k) => /^(access_?token|refresh_?token|token|secret|verifier|code)$/i.test(k))).toBe(false)
    }
    expect(calls[2].args).toMatchObject({ folderId: 'INBOX', limit: 10, pageToken: null })
  })

  it('maps a sign-in-needed error to SignInNeededError and keeps other codes', async () => {
    const a = client(() => new Error('sign_in_needed: the provider rejected the stored sign-in'))
    await expect(a.c.listFolders()).rejects.toBeInstanceOf(SignInNeededError)
    const b = client(() => new Error('host_rejected: evil.example.com is not an allowed mail host'))
    await expect(b.c.listFolders()).rejects.toMatchObject({ name: 'DesktopMailError', code: 'host_rejected' })
    const d = client(() => new Error('sign_in_denied: the provider reported a denial'))
    await expect(d.c.signIn()).rejects.toBeInstanceOf(DesktopMailError)
  })

  it('passes a user-configured host to Rust for validation', async () => {
    const { c, calls } = client(() => undefined)
    await c.registerHost('imap.fastmail.com')
    expect(calls[0]).toMatchObject({ command: 'mail_register_host', args: { accountId: 'acct-1', host: 'imap.fastmail.com' } })
  })
})
