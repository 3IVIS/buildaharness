import { EmailProviderError, type DraftInput } from '../provider.js'
import type { LocalMailActions, LocalMessageRef } from './local-mail.js'

/**
 * Changes made through Apple Mail's own automation (plans/aielia_email_capabilities_plan.html, D3): move, read, flag and save a draft. The
 * scripts live in Rust (`mail_local_script.rs`); this side only names an action and passes values, in chunks, and turns the short error codes
 * into errors a person can act on. Values are plain arguments: nothing here builds script text, so a subject or folder name with quotes,
 * backslashes or newlines is just data. Nothing here can send or delete. No `node:*` and no DOM imports.
 */

export type ScriptKind = 'move' | 'set_read' | 'set_flagged' | 'create_draft' | 'list_accounts'

/** Runs one allow-listed action and returns what the script printed. Implemented by the desktop app over `mail_local_script`. */
export interface ScriptRunner { run(kind: ScriptKind, args: string[]): Promise<string> }

export type ScriptInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export function tauriScriptRunner(invoke: ScriptInvoke): ScriptRunner {
  return { run: (kind, args) => invoke<string>('mail_local_script', { kind, args }) }
}

/** Unit separator between list entries and record separator inside one (the Rust scripts split on character ids 31 and 30). */
export const US = '\u001f'
export const RS = '\u001e'

/** A mailbox path as one value: segments joined by the unit separator (a folder name may contain a slash). */
export const pathArg = (segments: readonly string[]): string => segments.join(US)
/** The Message-ID without angle brackets; the script matches both forms. */
export const bareMessageId = (h: string): string => h.trim().replace(/^<|>$/g, '')

const CHUNK = 25

/** The error a person can act on, from the Rust code. */
export function explainScriptError(e: unknown): EmailProviderError {
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : 'unknown error'
  if (text.startsWith('automation_denied')) return new EmailProviderError('unauthorized', 'Allow Aielia to control Mail: System Settings, Privacy & Security, Automation, then switch on Mail under Aielia.')
  if (text.startsWith('mail_not_running')) return new EmailProviderError('unavailable', 'Mail is not running. Open Mail and try again.')
  if (text.startsWith('script_timeout')) return new EmailProviderError('unavailable', 'Mail did not answer in time. Try again with fewer messages.')
  if (text.startsWith('mail_object_not_found')) return new EmailProviderError('not_found', 'Mail could not find that account or folder. It may have been renamed or removed.')
  if (text.startsWith('unsupported_platform')) return new EmailProviderError('unavailable', 'This works only on a Mac with Apple Mail.')
  if (text.startsWith('bad_request')) return new EmailProviderError('invalid_argument', text)
  return new EmailProviderError('unavailable', `Mail could not do that: ${text.replace(/^script_failed:\s*/, '').slice(0, 160)}`)
}

function parseResult(out: string): { done: number; missed: number } {
  const m = /^ok:(\d+):(\d+)$/.exec(out.trim())
  if (!m) throw new EmailProviderError('unavailable', 'Mail gave an answer Aielia does not understand.')
  return { done: Number(m[1]), missed: Number(m[2]) }
}

export class AppleMailActions implements LocalMailActions {
  constructor(private readonly runner: ScriptRunner) {}

  private async run(kind: ScriptKind, args: string[]): Promise<string> {
    try { return await this.runner.run(kind, args) } catch (e) { throw e instanceof EmailProviderError ? e : explainScriptError(e) }
  }

  /** Group by (account, mailbox) and send in chunks; a message Mail cannot find is reported, not skipped silently. */
  private async each(refs: LocalMessageRef[], kind: ScriptKind, head: (r: LocalMessageRef) => string[]): Promise<void> {
    const groups = new Map<string, LocalMessageRef[]>()
    for (const r of refs) {
      if (!r.messageIdHeader) throw new EmailProviderError('invalid_argument', 'A message has no Message-ID, so Mail cannot be asked to change it.')
      const k = JSON.stringify([r.accountId, r.mailboxPath])
      groups.set(k, [...(groups.get(k) ?? []), r])
    }
    let missed = 0
    for (const g of groups.values()) {
      for (let i = 0; i < g.length; i += CHUNK) {
        const chunk = g.slice(i, i + CHUNK)
        const res = parseResult(await this.run(kind, [...head(chunk[0]!), ...chunk.map((r) => bareMessageId(r.messageIdHeader!))]))
        missed += res.missed
      }
    }
    if (missed > 0) throw new EmailProviderError('not_found', `${missed} message${missed === 1 ? ' was' : 's were'} not found in Mail (moved or deleted there since the last sync).`)
  }

  move(refs: LocalMessageRef[], destPath: string[]): Promise<void> {
    return this.each(refs, 'move', (r) => [r.accountId, pathArg(r.mailboxPath), pathArg(destPath)])
  }
  setRead(refs: LocalMessageRef[], read: boolean): Promise<void> {
    return this.each(refs, 'set_read', (r) => [r.accountId, pathArg(r.mailboxPath), String(read)])
  }
  setFlagged(refs: LocalMessageRef[], flagged: boolean): Promise<void> {
    return this.each(refs, 'set_flagged', (r) => [r.accountId, pathArg(r.mailboxPath), String(flagged)])
  }
  async createDraft(_accountId: string, d: DraftInput, fromAddress: string): Promise<void> {
    const list = (xs: ReadonlyArray<{ address: string; name?: string }> | undefined): string => (xs ?? []).map((x) => `${x.address}${RS}${x.name ?? ''}`).join(US)
    // Bcc is not carried: a blind copy is a decision to send, and this draft is only saved for the user to review and send in Mail.
    await this.run('create_draft', [fromAddress, d.subject, d.textBody, list(d.to), list(d.cc)])
  }

  /** The program's own account ids and names, for the setup screen. */
  async listAccounts(): Promise<Array<{ id: string; name: string }>> {
    const out = await this.run('list_accounts', [])
    return out.split('\n').filter(Boolean).map((l) => { const [id, ...rest] = l.split('\t'); return { id: id!, name: rest.join('\t') } })
  }
}
