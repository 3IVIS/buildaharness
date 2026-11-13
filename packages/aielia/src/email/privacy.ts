import { z } from 'zod'
import type { Account, Folder, Message } from './model.js'
import type { SettingsStore } from '../writer/write-permissions.js'

/**
 * Privacy controls for mail (decision 6): whether Aielia may read an account at all, and exclusions by folder and by sender.
 * Settings are stored per account through the same `get`/`set` settings store the writer's permissions use
 * (`write-permissions.ts`). Excluded mail is still synced, cached and usable by non-model features; only model input is blocked.
 * The default is OFF: an account that was never switched on is never read by a model.
 */

export const MailPrivacySchema = z.object({
  /** Aielia may read this account's mail text. */
  aieliaMayRead: z.boolean(),
  /** Folder ids or names (compared case-insensitively) whose mail is never read. */
  excludedFolders: z.array(z.string()),
  /** Sender addresses, or `@domain` to exclude a whole domain (compared case-insensitively). */
  excludedSenders: z.array(z.string()),
})
export type MailPrivacy = z.infer<typeof MailPrivacySchema>

export const DEFAULT_MAIL_PRIVACY: MailPrivacy = { aieliaMayRead: false, excludedFolders: [], excludedSenders: [] }

const key = (accountId: string): string => `email:privacy:${accountId}`

export async function loadMailPrivacy(store: SettingsStore, accountId: string): Promise<MailPrivacy> {
  const parsed = MailPrivacySchema.safeParse(await store.getSetting(key(accountId)))
  return parsed.success ? parsed.data : DEFAULT_MAIL_PRIVACY
}

export async function saveMailPrivacy(store: SettingsStore, accountId: string, privacy: MailPrivacy): Promise<void> {
  await store.setSetting(key(accountId), MailPrivacySchema.parse(privacy))
}

/** Copy the stored settings onto an account record, so `mayReadText(account, ...)` sees them. */
export function applyMailPrivacy(account: Account, privacy: MailPrivacy): Account {
  return { ...account, ...privacy }
}

type PrivacyAccount = Pick<Account, 'aieliaMayRead' | 'excludedFolders' | 'excludedSenders'>
export type FolderRef = Pick<Folder, 'id'> & Partial<Pick<Folder, 'name'>>

const norm = (s: string): string => s.trim().toLowerCase()

export function senderExcluded(excludedSenders: readonly string[], sender: string): boolean {
  const addr = norm(sender)
  return excludedSenders.some((entry) => {
    const e = norm(entry)
    if (!e) return false
    return e.startsWith('@') ? addr.endsWith(e) : addr === e
  })
}

export function folderExcluded(excludedFolders: readonly string[], folder: FolderRef | string): boolean {
  const ids = typeof folder === 'string' ? [folder] : [folder.id, ...(folder.name ? [folder.name] : [])]
  const set = new Set(excludedFolders.map(norm))
  return ids.some((x) => set.has(norm(x)))
}

/** May the text of mail from `sender` in `folder` be given to a model? */
export function mayReadText(account: PrivacyAccount, folder: FolderRef | string, sender: string): boolean {
  if (!account.aieliaMayRead) return false
  if (folderExcluded(account.excludedFolders, folder)) return false
  if (senderExcluded(account.excludedSenders, sender)) return false
  return true
}

/** A message may be read only if every folder it is in passes. A message in no known folder is judged on account and sender alone. */
export function mayReadMessage(account: PrivacyAccount, message: Pick<Message, 'folderIds' | 'from'>, folders: readonly FolderRef[] = []): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const refs: (FolderRef | string)[] = message.folderIds.length > 0 ? message.folderIds.map((id) => byId.get(id) ?? id) : ['']
  return refs.every((f) => mayReadText(account, f, message.from.address))
}
