import { z } from 'zod'
import type { SettingsStore } from '../writer/write-permissions.js'
import type { EmailCache } from './cache.js'
import type { SecretStore } from './secret-store.js'
import type { ProviderKind } from './model.js'
import { MAIL_ACTIVITY_KEY } from './mail-spend.js'

/**
 * Settings and data controls for Email (U8): what Aielia may do on its own, the spending cap, "delete all data" and "disconnect
 * account". Disconnect removes the account's token, its cache and its settings, and says how to revoke the grant at the provider
 * (we cannot do that for the user: the grant lives in their provider account). No `node:*` and no DOM imports; imports no LLM client.
 */

export const MailPermissionsSchema = z.object({
  /** File, label and archive mail without asking each time (every change is still logged and can be undone). Off by default: each change is shown first. */
  organiseWithoutAsking: z.boolean(),
  /** Stop all model calls once this much has been spent, in US dollars. Unset means no cap. */
  spendCapUsd: z.number().positive().optional(),
})
export type MailPermissions = z.infer<typeof MailPermissionsSchema>
export const DEFAULT_MAIL_PERMISSIONS: MailPermissions = { organiseWithoutAsking: false }

export const MAIL_PERMISSIONS_KEY = 'mail:permissions'
export const mailPrivacyKey = (accountId: string): string => `email:privacy:${accountId}`

export async function loadMailPermissions(store: SettingsStore): Promise<MailPermissions> {
  const parsed = MailPermissionsSchema.safeParse(await store.getSetting(MAIL_PERMISSIONS_KEY))
  return parsed.success ? parsed.data : DEFAULT_MAIL_PERMISSIONS
}

export async function saveMailPermissions(store: SettingsStore, permissions: MailPermissions): Promise<void> {
  await store.setSetting(MAIL_PERMISSIONS_KEY, MailPermissionsSchema.parse(permissions))
}

/** A settings store that can also remove a key. A store without `removeSetting` has the value set to undefined. */
export interface RemovableSettings extends SettingsStore {
  removeSetting?(key: string): Promise<void>
}

async function removeKey(store: RemovableSettings, key: string): Promise<void> {
  if (store.removeSetting) await store.removeSetting(key)
  else await store.setSetting(key, undefined)
}

/** Anything the host keeps per account beyond the cache, secrets and settings (the triage records, the action log): it clears them. */
export interface MailDataDeps {
  cache: EmailCache
  secrets: SecretStore
  settings: RemovableSettings
  /** Spend totals, if kept in the same settings store. */
  spend?: { reset(): void }
  /** Host-owned stores for one account (triage records, to-do corrections, drafts). */
  clearAccountExtras?: (accountId: string) => Promise<void> | void
  /** Host-owned stores that are not per account (the action log, voice profile). */
  clearGlobalExtras?: () => Promise<void> | void
}

export const REVOKE_STEPS: Record<string, { where: string; url?: string; steps: string }> = {
  gmail: {
    where: 'your Google Account',
    url: 'https://myaccount.google.com/permissions',
    steps: 'Open your Google Account, choose Security, then "Third-party apps with account access" (or "Your connections to third-party apps and services"), pick Aielia and choose Remove access.',
  },
  graph: {
    where: 'your Microsoft account',
    url: 'https://account.microsoft.com/privacy/app-access',
    steps: 'Open your Microsoft account, choose Privacy, then "Apps and services" (app access), pick Aielia and choose Remove these permissions.',
  },
  imap: {
    where: 'your mail provider',
    steps: 'If you used an app password, delete that app password in your mail provider\'s security settings; removing it here does not remove it there.',
  },
}

export function revokeInstructions(provider: ProviderKind | string): { where: string; url?: string; steps: string } {
  const known = REVOKE_STEPS[provider]
  return known ?? { where: 'your mail provider', steps: 'Open the security or connected-apps page of your mail provider and remove Aielia, or delete the app password you gave it. Removing it here does not remove it there.' }
}

export interface DisconnectResult {
  accountId: string
  /** What was removed here. */
  removed: Array<'token' | 'cache' | 'settings' | 'extras'>
  revoke: { where: string; url?: string; steps: string }
}

/** Remove one account's token, cache, privacy settings and host extras. The grant at the provider stays until the user revokes it, so the result says how. */
export async function disconnectAccount(deps: MailDataDeps, account: { id: string; provider: ProviderKind | string }): Promise<DisconnectResult> {
  await deps.secrets.delete(account.id)
  await deps.cache.clearAccount(account.id)
  await removeKey(deps.settings, mailPrivacyKey(account.id))
  await deps.clearAccountExtras?.(account.id)
  return { accountId: account.id, removed: ['token', 'cache', 'settings', 'extras'], revoke: revokeInstructions(account.provider) }
}

/** Remove everything Email has stored for these accounts, plus permissions, activity and spend totals. Tokens go too, so each account must be connected again. */
export async function deleteAllMailData(deps: MailDataDeps, accounts: ReadonlyArray<{ id: string; provider: ProviderKind | string }>): Promise<DisconnectResult[]> {
  const results: DisconnectResult[] = []
  for (const a of accounts) results.push(await disconnectAccount(deps, a))
  await removeKey(deps.settings, MAIL_PERMISSIONS_KEY)
  await removeKey(deps.settings, MAIL_ACTIVITY_KEY)
  deps.spend?.reset()
  await deps.clearGlobalExtras?.()
  return results
}
