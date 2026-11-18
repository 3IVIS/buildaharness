import { InMemoryEmailCache, LocalMailProvider, syncForWindow, type Account, type EmailProvider, type LocalMailActions, type LocalMailSource, type Message, type SettingsStore } from '@buildaharness/aielia'
import type { SampleMailbox } from './sample-mode'

/** A settings store that lives for the session (the review window and the covered range are re-derived on the next start). */
const sessionSettings = (): SettingsStore => {
  const m = new Map<string, unknown>()
  return { getSetting: async (k: string) => m.get(k), setSetting: async (k: string, v: unknown) => { m.set(k, v) } }
}

export interface LocalMailboxOptions {
  source: LocalMailSource
  /** The mail program's own account ids chosen on the setup screen. */
  accountIds: string[]
  actions?: LocalMailActions
  /** Review window in days (default 30), the same choice the rest of Email offers. */
  windowDays?: 7 | 30 | 90 | 365 | 'all'
  now?: Date
}

/**
 * The live, read-only mailbox over mail already on this computer, in the shape the Email screen shows. Each chosen account gets a provider and a cache,
 * is synced for the review window (a dated query in the program's own index), and its folders and messages are read from the cache. The account record
 * starts with the AI read switch OFF, like every account. There is no server to search, so the screen hides that action, and the chat says plainly that
 * it is not connected here yet.
 */
export async function createLocalMailbox(o: LocalMailboxOptions): Promise<SampleMailbox> {
  const settings = sessionSettings()
  const parts: Array<{ provider: LocalMailProvider; cache: InMemoryEmailCache; suffix: string }> = []
  for (const [i, id] of o.accountIds.entries()) {
    const account: Account = {
      id: `local:${id}`, provider: 'apple_mail', address: 'this-computer@local', displayName: o.accountIds.length > 1 ? `Mail on this computer (${i + 1})` : 'Mail on this computer',
      aieliaMayRead: false, excludedFolders: [], excludedSenders: [],
    }
    const provider = new LocalMailProvider({ account, source: o.source, localAccountId: id, ...(o.actions ? { actions: o.actions } : {}) })
    const cache = new InMemoryEmailCache()
    await syncForWindow(provider, cache, settings, o.windowDays ?? 30, { ...(o.now ? { now: o.now } : {}) })
    parts.push({ provider, cache, suffix: o.accountIds.length > 1 ? ` (${i + 1})` : '' })
  }
  const folders = (await Promise.all(parts.map(async (p) => (await p.cache.getFolders(p.provider.account.id)).map((f) => ({ ...f, name: `${f.name}${p.suffix}` }))))).flat()
  const cacheOf = new Map(folders.map((f) => [f.id, parts.find((p) => p.provider.account.id === f.accountId)!.cache] as const))
  const loadFolder = async (folderId: string): Promise<Message[]> => {
    const cache = cacheOf.get(folderId)
    return cache ? (await cache.queryMessages({ folderId }, { offset: 0, limit: 500 })).items : []
  }
  const inboxes = folders.filter((f) => f.kind === 'inbox')
  const inbox = (await Promise.all(inboxes.map((f) => loadFolder(f.id)))).flat().sort((a, b) => b.date.localeCompare(a.date))
  const first: EmailProvider = parts[0]!.provider
  return {
    provider: first, folders, inbox, todo: [], spam: [],
    live: { label: 'Apple Mail on this computer.', serverSearch: false },
    loadFolder,
    ask: async () => ({ reply: 'Aielia\'s mail chat is not connected to a model in this version, so it cannot answer about this mailbox yet. You can still read and search it here.', model: 'local' }),
  }
}
