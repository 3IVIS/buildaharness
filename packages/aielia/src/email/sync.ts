import type { EmailCache } from './cache.js'
import { EmailProviderError, type EmailProvider } from './provider.js'

/**
 * Incremental sync from an EmailProvider into an EmailCache (plans/aielia_email_plan.html, F6). No `node:*` and no DOM
 * imports. The per-account sync token doubles as the resume marker:
 *
 *  - absent: nothing synced yet. The engine takes the provider's current change token FIRST (so anything that changes while
 *    the listing runs is replayed afterwards), then lists folders, then every folder's messages and threads in pages.
 *  - `partial:<json>`: an initial listing was interrupted. The json holds the baseline token, the folder index and the page
 *    cursor, so the next call continues where it stopped. Upserts are idempotent, so a repeated page is harmless.
 *  - anything else: the provider's change token. The engine applies `listChanges` (upserts, deletes, moves) and stores the
 *    new token last, so an interruption mid-apply re-applies the same changes on the next call.
 *
 * When the provider reports `fullResyncNeeded` the account is cleared and the initial listing starts over.
 */

export interface SyncOptions {
  /** Items per provider page. Default 50. */
  pageSize?: number
  /** Checked before every provider page during the initial listing; true stops the run with `interrupted`. */
  shouldStop?: () => boolean
  /**
   * Review window (plan C2): ISO instant; only mail received at or after it is listed and stored. Passed to the provider as a hint and
   * enforced here, so a provider that ignores the hint is still correct. Absent means the whole mailbox.
   */
  since?: string
}

export type SyncMode = 'initial' | 'incremental' | 'full_resync'

export interface SyncResult {
  mode: SyncMode
  /** `interrupted` means the run stopped early and calling `syncAccount` again resumes it. */
  status: 'complete' | 'interrupted'
  messagesUpserted: number
  messagesDeleted: number
  threadsUpserted: number
  threadsDeleted: number
  pages: number
}

interface PartialState {
  baseline: string
  /** Index into the sorted folder id list. */
  folder: number
  /** Which listing within the folder: messages first, then threads. */
  phase: 'messages' | 'threads'
  pageToken?: string
  /** The window the interrupted listing was using; a run with a different window starts over. */
  since?: string
}

const PARTIAL_PREFIX = 'partial:'
const DEFAULT_PAGE_SIZE = 50

function parsePartial(token: string | undefined): PartialState | undefined {
  if (!token?.startsWith(PARTIAL_PREFIX)) return undefined
  try {
    const s = JSON.parse(token.slice(PARTIAL_PREFIX.length)) as PartialState
    if (typeof s.baseline === 'string' && Number.isInteger(s.folder) && (s.phase === 'messages' || s.phase === 'threads')) return s
  } catch {
    /* fall through: an unreadable marker means start over */
  }
  return undefined
}

export async function syncAccount(provider: EmailProvider, cache: EmailCache, opts: SyncOptions = {}): Promise<SyncResult> {
  const accountId = provider.account.id
  const token = await cache.getSyncToken(accountId)
  const result: SyncResult = { mode: 'initial', status: 'complete', messagesUpserted: 0, messagesDeleted: 0, threadsUpserted: 0, threadsDeleted: 0, pages: 0 }

  if (token === undefined) return initialListing(provider, cache, opts, undefined, result)
  if (token.startsWith(PARTIAL_PREFIX)) {
    const state = parsePartial(token)
    // An unreadable marker cannot be resumed; clear the half-filled cache and begin again.
    if (!state || state.since !== opts.since) {
      await cache.clearAccount(accountId)
      return initialListing(provider, cache, opts, undefined, result)
    }
    return initialListing(provider, cache, opts, state, result)
  }

  result.mode = 'incremental'
  const changes = await provider.listChanges(token)
  if (changes.fullResyncNeeded) {
    await cache.clearAccount(accountId)
    result.mode = 'full_resync'
    return initialListing(provider, cache, opts, undefined, result)
  }
  await applyChanges(provider, cache, changes.changes, result, opts.since)
  await cache.setSyncToken(accountId, changes.syncToken)
  return result
}

async function initialListing(
  provider: EmailProvider, cache: EmailCache, opts: SyncOptions, resume: PartialState | undefined, result: SyncResult,
): Promise<SyncResult> {
  const accountId = provider.account.id
  const limit = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const baseline = resume?.baseline ?? (await provider.listChanges(undefined)).syncToken
  const folders = (await provider.listFolders()).sort((a, b) => a.id.localeCompare(b.id))
  await cache.upsertFolders(folders)

  let folder = resume?.folder ?? 0
  let phase: PartialState['phase'] = resume?.phase ?? 'messages'
  let pageToken = resume?.pageToken

  const save = (): Promise<void> => {
    const state: PartialState = { baseline, folder, phase, ...(pageToken === undefined ? {} : { pageToken }), ...(opts.since === undefined ? {} : { since: opts.since }) }
    return cache.setSyncToken(accountId, PARTIAL_PREFIX + JSON.stringify(state))
  }
  // Mark the run as started before the first page so an immediate interruption is resumable too.
  await save()

  while (folder < folders.length) {
    for (;;) {
      if (opts.shouldStop?.()) {
        result.status = 'interrupted'
        return result
      }
      const folderId = folders[folder]!.id
      if (phase === 'messages') {
        const p = await provider.listMessages(folderId, { limit, ...(pageToken === undefined ? {} : { pageToken }), ...(opts.since ? { since: opts.since } : {}) })
        const kept = opts.since ? p.items.filter((m) => m.date >= opts.since!) : p.items
        await cache.upsertMessages(kept)
        result.messagesUpserted += kept.length
        result.pages += 1
        pageToken = p.nextPageToken
        if (pageToken === undefined) phase = 'threads'
      } else {
        const p = await provider.listThreads(folderId, { limit, ...(pageToken === undefined ? {} : { pageToken }), ...(opts.since ? { since: opts.since } : {}) })
        const kept = opts.since ? p.items.filter((t) => t.lastMessageAt >= opts.since!) : p.items
        await cache.upsertThreads(kept)
        result.threadsUpserted += kept.length
        result.pages += 1
        pageToken = p.nextPageToken
        if (pageToken === undefined) break
      }
      await save()
    }
    folder += 1
    phase = 'messages'
    pageToken = undefined
    await save()
  }

  // Replay anything that changed while the listing ran, then switch to the baseline token's successor.
  const tail = await provider.listChanges(baseline)
  if (tail.fullResyncNeeded) {
    // The provider's history moved past our baseline mid-run: start over from a clean cache.
    await cache.clearAccount(accountId)
    result.messagesUpserted = result.threadsUpserted = result.pages = 0
    return initialListing(provider, cache, opts, undefined, result)
  }
  await applyChanges(provider, cache, tail.changes, result, opts.since)
  await cache.setSyncToken(accountId, tail.syncToken)
  return result
}

async function applyChanges(
  provider: EmailProvider, cache: EmailCache, changes: Array<{ type: 'upsert' | 'delete'; messageId: string }>, result: SyncResult, since?: string,
): Promise<void> {
  const touchedThreads = new Set<string>()
  const deletes: string[] = []
  for (const c of changes) {
    const cached = await cache.getMessage(c.messageId)
    if (cached) touchedThreads.add(cached.threadId)
    if (c.type === 'delete') {
      deletes.push(c.messageId)
      continue
    }
    try {
      // An upsert replaces the whole record, so a move (new folderIds) lands here too.
      const m = await provider.getMessage(c.messageId)
      // Old mail outside the review window that we never stored (a flag changed on it, say) is not pulled in.
      if (!cached && since && m.date < since) continue
      await cache.upsertMessages([m])
      result.messagesUpserted += 1
      touchedThreads.add(m.threadId)
    } catch (e) {
      // Changed and then removed before we looked: treat as a delete.
      if (e instanceof EmailProviderError && e.code === 'not_found') deletes.push(c.messageId)
      else throw e
    }
  }
  if (deletes.length > 0) {
    await cache.deleteMessages(deletes)
    result.messagesDeleted += deletes.length
  }
  for (const threadId of touchedThreads) {
    try {
      const { thread } = await provider.getThread(threadId)
      await cache.upsertThreads([thread])
      result.threadsUpserted += 1
    } catch (e) {
      if (e instanceof EmailProviderError && e.code === 'not_found') {
        await cache.deleteThreads([threadId])
        result.threadsDeleted += 1
      } else throw e
    }
  }
}

/**
 * Widen the window: list every folder for mail received at or after `since` and store it, leaving what is already cached alone. Idempotent
 * (upserts), so an interrupted run is simply run again. The change token is untouched: changes since the last sync still arrive through
 * `syncAccount`. Narrowing needs no call: the cache keeps what it has and only what is reviewed shrinks.
 */
export async function backfillWindow(provider: EmailProvider, cache: EmailCache, since: string | undefined, opts: Pick<SyncOptions, 'pageSize' | 'shouldStop'> = {}): Promise<SyncResult> {
  const result: SyncResult = { mode: 'incremental', status: 'complete', messagesUpserted: 0, messagesDeleted: 0, threadsUpserted: 0, threadsDeleted: 0, pages: 0 }
  const limit = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const folders = (await provider.listFolders()).sort((a, b) => a.id.localeCompare(b.id))
  await cache.upsertFolders(folders)
  for (const f of folders) {
    for (const phase of ['messages', 'threads'] as const) {
      let pageToken: string | undefined
      do {
        if (opts.shouldStop?.()) return { ...result, status: 'interrupted' }
        const o = { limit, ...(pageToken === undefined ? {} : { pageToken }), ...(since ? { since } : {}) }
        if (phase === 'messages') {
          const p = await provider.listMessages(f.id, o)
          const kept = since ? p.items.filter((m) => m.date >= since) : p.items
          await cache.upsertMessages(kept)
          result.messagesUpserted += kept.length
          pageToken = p.nextPageToken
        } else {
          const p = await provider.listThreads(f.id, o)
          const kept = since ? p.items.filter((t) => t.lastMessageAt >= since) : p.items
          await cache.upsertThreads(kept)
          result.threadsUpserted += kept.length
          pageToken = p.nextPageToken
        }
        result.pages += 1
      } while (pageToken)
    }
  }
  return result
}
