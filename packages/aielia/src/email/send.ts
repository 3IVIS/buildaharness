import type { SendEmail, SendEmailResult } from '../email.js'
import { formatEmailApprovalReason } from '../email.js'
import type { Address } from './model.js'
import type { EmailProvider } from './provider.js'

/**
 * Send through the account's own provider, behind staged approval (plans/aielia_email_plan.html, phase P3, decision 3).
 * A message is staged first and nothing leaves until `approve()` is given the fingerprint of exactly what was shown.
 * Changing any recipient, the subject or the text after staging changes the fingerprint, so the old approval no longer
 * matches and the user must approve again. The approval text lists every recipient (Cc and Bcc included), and a recipient
 * who is not on the thread being replied to gets an extra warning. An optional delay holds an approved message as a
 * provider draft until it is released; undo inside the delay deletes the draft. Pure over the provider port and an
 * injected clock: no node:* and no DOM imports.
 */

export interface StagedMessage {
  /** Set when the message replies inside a thread. */
  threadId?: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  textBody: string
}

export type SendErrorCode = 'unknown_staged' | 'needs_reapproval' | 'not_pending' | 'no_recipient' | 'bad_address'

export class EmailSendError extends Error {
  constructor(public readonly code: SendErrorCode, message: string) {
    super(message)
    this.name = 'EmailSendError'
  }
}

const norm = (a: string): string => a.trim().toLowerCase()

/** Accepts "a@x.org" or a comma-separated list; refuses anything without one @ and a dotted domain. No regex. */
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return []
  const out: Address[] = []
  for (const part of value.split(',')) {
    const address = part.trim()
    if (address === '') continue
    const at = address.indexOf('@')
    const domain = address.slice(at + 1)
    const ok = at > 0 && at === address.lastIndexOf('@') && !address.includes(' ') && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
    if (!ok) throw new EmailSendError('bad_address', `"${address}" is not a valid email address`)
    out.push({ address })
  }
  return out
}

/** What the approver sees is what is hashed: every field that reaches the provider, in a fixed order. */
export function fingerprintMessage(m: StagedMessage): string {
  const list = (xs: Address[]): string[] => xs.map((a) => norm(a.address)).sort()
  return JSON.stringify([m.threadId ?? null, list(m.to), list(m.cc), list(m.bcc), m.subject, m.textBody])
}

/** Recipients (To, Cc, Bcc) who appear nowhere on the thread being replied to. Empty when the message starts a new thread. */
export async function offThreadRecipients(provider: EmailProvider, m: StagedMessage): Promise<string[]> {
  if (!m.threadId) return []
  const { messages } = await provider.getThread(m.threadId)
  const known = new Set<string>()
  for (const msg of messages) for (const a of [msg.from, ...msg.to, ...msg.cc]) known.add(norm(a.address))
  const seen = new Set<string>()
  const off: string[] = []
  for (const a of [...m.to, ...m.cc, ...m.bcc]) {
    const k = norm(a.address)
    if (!known.has(k) && !seen.has(k)) { seen.add(k); off.push(a.address) }
  }
  return off
}

export interface StagedSend {
  id: string
  message: StagedMessage
  fingerprint: string
  warnings: string[]
  /** Complete text for the approval prompt. */
  approvalText: string
}

export type SendStatus = 'staged' | 'held' | 'sent' | 'undone'

interface Entry {
  message: StagedMessage
  fingerprint: string
  status: SendStatus
  draftId?: string
  releaseAt?: number
  sentId?: string
}

export interface SendOptions {
  /** Seconds an approved message is held before it goes. Zero sends at once. */
  delaySeconds?: number
  now?: () => number
}

const joinAddrs = (xs: Address[]): string => xs.map((a) => a.address).join(', ')

export class SendCoordinator {
  private entries = new Map<string, Entry>()
  private seq = 0
  constructor(private readonly provider: EmailProvider, private readonly opts: SendOptions = {}) {}

  private clock(): number { return (this.opts.now ?? Date.now)() }

  async stage(message: StagedMessage): Promise<StagedSend> {
    if (message.to.length === 0) throw new EmailSendError('no_recipient', 'A message needs at least one To recipient.')
    const id = `send-${++this.seq}`
    return this.record(id, structuredClone(message))
  }

  /** Replace the staged content. The new fingerprint differs from any earlier approval whenever the content differs. */
  async restage(id: string, message: StagedMessage): Promise<StagedSend> {
    const e = this.require(id)
    if (e.status !== 'staged') throw new EmailSendError('not_pending', `${id} is already ${e.status}`)
    if (message.to.length === 0) throw new EmailSendError('no_recipient', 'A message needs at least one To recipient.')
    return this.record(id, structuredClone(message))
  }

  private async record(id: string, message: StagedMessage): Promise<StagedSend> {
    const fingerprint = fingerprintMessage(message)
    const off = await offThreadRecipients(this.provider, message)
    const warnings = off.map((a) => `${a} was not on this thread`)
    this.entries.set(id, { message, fingerprint, status: 'staged' })
    const approvalText = formatEmailApprovalReason(
      { to: joinAddrs(message.to), cc: joinAddrs(message.cc) || undefined, bcc: joinAddrs(message.bcc) || undefined, subject: message.subject, body: message.textBody },
      warnings,
    )
    return { id, message: structuredClone(message), fingerprint, warnings, approvalText }
  }

  /**
   * Approve exactly the content whose fingerprint the user saw. A mismatch means the staged message changed since:
   * nothing is sent and the caller must show the new text for a fresh approval.
   */
  async approve(id: string, approvedFingerprint: string): Promise<{ status: 'sent' | 'held'; messageId: string; releaseAt?: number }> {
    const e = this.require(id)
    if (e.status !== 'staged') throw new EmailSendError('not_pending', `${id} is already ${e.status}`)
    if (approvedFingerprint !== e.fingerprint) throw new EmailSendError('needs_reapproval', `${id} changed after it was shown: approve it again`)
    const m = e.message
    const draft = await this.provider.createDraft({
      threadId: m.threadId, to: m.to, cc: m.cc.length ? m.cc : undefined, bcc: m.bcc.length ? m.bcc : undefined, subject: m.subject, textBody: m.textBody,
    })
    const delay = this.opts.delaySeconds ?? 0
    if (delay > 0) {
      e.status = 'held'
      e.draftId = draft.id
      e.releaseAt = this.clock() + delay * 1000
      return { status: 'held', messageId: draft.id, releaseAt: e.releaseAt }
    }
    const sent = await this.provider.send(draft.id)
    e.status = 'sent'
    e.sentId = sent.id
    return { status: 'sent', messageId: sent.id }
  }

  /** Sends every held message whose delay has passed. Returns the ids sent. */
  async releaseDue(): Promise<string[]> {
    const out: string[] = []
    for (const [id, e] of this.entries) {
      if (e.status === 'held' && e.draftId && e.releaseAt !== undefined && this.clock() >= e.releaseAt) {
        const sent = await this.provider.send(e.draftId)
        e.status = 'sent'
        e.sentId = sent.id
        out.push(id)
      }
    }
    return out
  }

  /** Cancels a held message: its draft is deleted and nothing is sent. Too late once the delay has passed and it went. */
  async undo(id: string): Promise<void> {
    const e = this.require(id)
    if (e.status !== 'held' || !e.draftId) throw new EmailSendError('not_pending', `${id} is ${e.status}: nothing to undo`)
    await this.provider.delete([e.draftId])
    e.status = 'undone'
  }

  status(id: string): SendStatus { return this.require(id).status }

  private require(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new EmailSendError('unknown_staged', `no staged message ${id}`)
    return e
  }
}

/**
 * A `SendEmail` transport over the account's provider, for the existing staged-action path (`applyPendingAction`), which
 * has already shown the approval and received the user's yes. Sends at once: the delay belongs to `SendCoordinator`.
 */
export function createProviderSender(provider: EmailProvider): SendEmail {
  return async (message): Promise<SendEmailResult> => {
    const to = parseAddressList(message.to)
    if (to.length === 0) throw new EmailSendError('no_recipient', 'A message needs at least one To recipient.')
    const cc = parseAddressList(message.cc)
    const bcc = parseAddressList(message.bcc)
    const draft = await provider.createDraft({ to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, subject: message.subject, textBody: message.body })
    const sent = await provider.send(draft.id)
    return { provider: 'account', id: sent.id }
  }
}
