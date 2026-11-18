import { z } from 'zod'
import type { SettingsStore } from '../writer/write-permissions.js'
import type { EmailCache } from './cache.js'
import type { EmailProvider } from './provider.js'
import { backfillWindow, syncAccount, type SyncOptions, type SyncResult } from './sync.js'

/**
 * The review window (plans/aielia_email_capabilities_plan.html, C2): how far back Aielia syncs and reviews mail, per account. Kept in the
 * settings store beside the privacy settings rather than on the account record, so existing accounts need no migration. The window is a
 * number of days or `all`; the default is 30. `windowSince` turns it into the instant the sync engine filters on. No `node:*` and no DOM imports.
 */

export const REVIEW_WINDOW_DAYS = [7, 30, 90, 365] as const
export const ReviewWindowSchema = z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365), z.literal('all')])
export type ReviewWindow = z.infer<typeof ReviewWindowSchema>
export const REVIEW_WINDOWS: readonly ReviewWindow[] = [7, 30, 90, 365, 'all']
export const DEFAULT_REVIEW_WINDOW: ReviewWindow = 30

export const reviewWindowLabel = (w: ReviewWindow): string => (w === 'all' ? 'All messages' : `Last ${w} days`)

const DAY_MS = 86_400_000
/** The earliest instant inside the window, as ISO; undefined for `all`. */
export function windowSince(w: ReviewWindow, now: Date = new Date()): string | undefined {
  return w === 'all' ? undefined : new Date(now.getTime() - w * DAY_MS).toISOString()
}

const windowKey = (accountId: string): string => `email:review-window:${accountId}`
const coveredKey = (accountId: string): string => `email:window-covered:${accountId}`

export async function loadReviewWindow(store: SettingsStore, accountId: string): Promise<ReviewWindow> {
  const parsed = ReviewWindowSchema.safeParse(await store.getSetting(windowKey(accountId)))
  return parsed.success ? parsed.data : DEFAULT_REVIEW_WINDOW
}
export async function saveReviewWindow(store: SettingsStore, accountId: string, w: ReviewWindow): Promise<void> {
  await store.setSetting(windowKey(accountId), ReviewWindowSchema.parse(w))
}

/** The earliest instant the cache is known to cover (`'all'` for everything, absent before the first sync). */
const CoveredSchema = z.object({ since: z.string().nullable() })
async function loadCovered(store: SettingsStore, accountId: string): Promise<{ since: string | null } | undefined> {
  const p = CoveredSchema.safeParse(await store.getSetting(coveredKey(accountId)))
  return p.success ? p.data : undefined
}
const saveCovered = (store: SettingsStore, accountId: string, since: string | undefined): Promise<void> => store.setSetting(coveredKey(accountId), { since: since ?? null })

export interface WindowSyncResult { sync: SyncResult; backfill?: SyncResult; since: string | undefined }

/**
 * Sync the account for its review window. First sync lists only the window; later syncs apply changes; a window wider than what the
 * cache covers backfills the missing range first. A narrower window changes nothing in the cache. `now` is the instant the window is
 * measured from (a calendar day boundary is not assumed).
 */
export async function syncForWindow(
  provider: EmailProvider, cache: EmailCache, store: SettingsStore, window: ReviewWindow, opts: Omit<SyncOptions, 'since'> & { now?: Date } = {},
): Promise<WindowSyncResult> {
  const accountId = provider.account.id
  const since = windowSince(window, opts.now)
  const covered = await loadCovered(store, accountId)
  const hadSync = (await cache.getSyncToken(accountId)) !== undefined
  let backfill: SyncResult | undefined
  // The first run, and a run after an interrupted first run, sync with the window; the covered mark is written only when it completes.
  const keep = covered && hadSync && !(await cache.getSyncToken(accountId))?.startsWith('partial:')
  const wider = keep && covered.since !== null && (since === undefined || since < covered.since)
  if (wider) {
    backfill = await backfillWindow(provider, cache, since, opts)
    if (backfill.status === 'interrupted') return { sync: { mode: 'incremental', status: 'interrupted', messagesUpserted: 0, messagesDeleted: 0, threadsUpserted: 0, threadsDeleted: 0, pages: 0 }, backfill, since }
    await saveCovered(store, accountId, since)
  }
  // Incremental changes use the covered start, not the new one, so mail outside what we hold is never half-pulled in.
  const syncSince = keep ? (wider ? since : covered.since === null ? undefined : covered.since) : since
  const sync = await syncAccount(provider, cache, { ...opts, ...(syncSince ? { since: syncSince } : {}) })
  if (!keep && sync.status === 'complete') await saveCovered(store, accountId, since)
  return { sync, ...(backfill ? { backfill } : {}), since }
}
