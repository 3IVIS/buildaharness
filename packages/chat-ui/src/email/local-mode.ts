import type { ILLMClient } from '@buildaharness/runtime'
import {
  EmailWorkbench, InMemoryEmailCache, LocalMailProvider, classifyLocalFolder, inferOwnAddress, resolveFolderKinds, syncForWindow,
  type Account, type EmailProvider, type LocalMailActions, type LocalMailSource, type Message, type SettingsStore, type WorkbenchEvent,
} from '@buildaharness/aielia'
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
  /** The app's own model connection. With it the mailbox gets the capabilities (catch-up, spam, rules, to-do, chat); without it the chat says it is not connected. */
  llm?: ILLMClient
  /** Everything the capabilities do (model calls with their prompts, tool calls, results), for the activity panel. */
  onEvent?: (e: WorkbenchEvent) => void
}

const modelOf = (llm: ILLMClient) => async (system: string, user: string): Promise<string> =>
  llm.callChatSync([{ role: 'system', content: system }, { role: 'user', content: user }], { maxTokens: 4000 })

/**
 * The live, read-only mailbox over mail already on this computer, in the shape the Email screen shows. Each chosen account gets a provider and a cache,
 * is synced for the review window (a dated query in the program's own index), and its folders and messages are read from the cache. The account record
 * starts with the AI read switch OFF, like every account; choosing the account on the setup screen is the consent to read it, so it is switched on only
 * when a model is connected and the capabilities are offered. There is no server to search, so the screen hides that action.
 *
 * With a model, folder names the name table does not know (another language) are resolved once, with the names only, and the owner's own address is
 * inferred from the Sent folder, so "people you have written to" works. The capabilities run on the FIRST chosen account.
 */
export async function createLocalMailbox(o: LocalMailboxOptions): Promise<SampleMailbox> {
  const settings = sessionSettings()
  const model = o.llm ? modelOf(o.llm) : undefined
  const parts: Array<{ provider: LocalMailProvider; cache: InMemoryEmailCache; suffix: string }> = []
  for (const [i, id] of o.accountIds.entries()) {
    const paths = (await o.source.mailboxes()).filter((b) => b.accountId === id).map((b) => b.path)
    const folderKinds = model ? await resolveFolderKinds(paths, model) : new Map()
    const kindOf = (p: readonly string[]) => { const k = classifyLocalFolder(p); return k === 'custom' ? (folderKinds.get(p.join('/')) ?? 'custom') : k }
    const own = model ? await inferOwnAddress(o.source, id, kindOf) : undefined
    const account: Account = {
      id: `local:${id}`, provider: 'apple_mail', address: own ?? 'this-computer@local', displayName: o.accountIds.length > 1 ? `Mail on this computer (${i + 1})` : 'Mail on this computer',
      aieliaMayRead: model !== undefined, excludedFolders: [], excludedSenders: [],
    }
    const provider = new LocalMailProvider({ account, source: o.source, localAccountId: id, folderKinds, ...(o.actions ? { actions: o.actions } : {}) })
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
  let workbench: EmailWorkbench | undefined
  if (model) {
    workbench = new EmailWorkbench({ provider: first, cache: parts[0]!.cache, model, window: o.windowDays ?? 30, ...(o.onEvent ? { onEvent: o.onEvent } : {}), ...(o.now ? { now: () => o.now!.toISOString() } : {}) })
    await workbench.refresh()
  }
  const wb = workbench
  return {
    provider: first, folders, inbox, todo: [], spam: [],
    live: { label: 'Apple Mail on this computer.', serverSearch: false },
    loadFolder,
    ...(wb ? { workbench: wb } : {}),
    ask: wb
      ? async (text: string) => {
          const a = await wb.ask(text)
          return { reply: a.cited.length ? `${a.reply}\n\nFrom: ${a.cited.map((c) => c.subject).join('; ')}` : a.reply, model: 'app' }
        }
      : async () => ({ reply: 'Aielia\'s mail chat is not connected to a model here, so it cannot answer about this mailbox. You can still read and search it.', model: 'local' }),
  }
}
