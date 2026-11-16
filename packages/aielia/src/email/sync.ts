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
    if (!state) {
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
  await applyChanges(provider, cache, changes.changes, result)
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
    const state: PartialState = { baseline, folder, phase, ...(pageToken === undefined ? {} : { pageToken }) }
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
        const p = await provider.listMessages(folderId, { limit, ...(pageToken === undefined ? {} : { pageToken }) })
        await cache.upsertMessages(p.items)
        result.messagesUpserted += p.items.length
        result.pages += 1
        pageToken = p.nextPageToken
        if (pageToken === undefined) phase = 'threads'
      } else {
        const p = await provider.listThreads(folderId, { limit, ...(pageToken === undefined ? {} : { pageToken }) })
        await cache.upsertThreads(p.items)
        result.threadsUpserted += p.items.length
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
  await applyChanges(provider, cache, tail.changes, result)
  await cache.setSyncToken(accountId, tail.syncToken)
  return result
}

async function applyChanges(
  provider: EmailProvider, cache: EmailCache, changes: Array<{ type: 'upsert' | 'delete'; messageId: string }>, result: SyncResult,
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
