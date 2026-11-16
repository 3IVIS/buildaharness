import type { Account, Message } from './model.js'
import type { FolderRef } from './privacy.js'
import { mayReadMessage } from './privacy.js'
import { wrapUntrusted } from '../trust-tagging.js'

/**
 * The single choke point (F8): every later phase builds model input from mail through `buildMailModelInput`, and no other
 * module in `email/` may import an LLM client (enforced by a source-scan test). Blocked mail yields no text at all, so a
 * caller cannot forward it by accident. The text is wrapped as untrusted; F9 adds flagging on top.
 */

export type MailField = 'headers' | 'body'

export type MailModelInput = { ok: true; text: string } | { ok: false; reason: 'account_off' | 'excluded' }

export function buildMailModelInput(
  account: Pick<Account, 'aieliaMayRead' | 'excludedFolders' | 'excludedSenders'>,
  message: Message,
  folders: readonly FolderRef[] = [],
  fields: readonly MailField[] = ['headers', 'body'],
): MailModelInput {
  if (!mayReadMessage(account, message, folders)) return { ok: false, reason: account.aieliaMayRead ? 'excluded' : 'account_off' }
  const parts: string[] = []
  if (fields.includes('headers')) {
    const from = message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address
    parts.push(`From: ${from}`, `To: ${message.to.map((a) => a.address).join(', ')}`, `Date: ${message.date}`, `Subject: ${message.subject}`)
  }
  if (fields.includes('body')) parts.push('', message.textBody)
  return { ok: true, text: wrapUntrusted(parts.join('\n')) }
}
