import {
  createActivityLog,
  type ActivityLog,
  type FolderReader,
  ArticleService,
  serializeByArticle,
  PersonalAssistant,
  WEB_FEATURES,
  buildAssistantOptions,
  modelFailureHint,
  recordWriterMessage,
  readWriterIntent,
  type WriterIntent,
  createArticleChatPort,
  createLlmClient,
  createMemoryAdapterArticleStore,
  createSpendMeter,
  defaultWriteModels,
  loadPermissions,
  savePermissions,
  suggestedModels,
  withSpendCap,
  type ArticleStore,
  type SpendSnapshot,
  type AssistantConfig,
  type WritePermissions,
  type WriterChatPort,
} from '@buildaharness/aielia'
import { IndexedDBAdapter, type ILLMClient } from '@buildaharness/runtime'
import { getAssistantTestHooks } from '../assistant-test-hooks'
import { createProxyWebTools, pageReader } from '../web-context'
import { browserFolderPicker } from './folder-access'

/** The models the page uses. `chat` is for the chat, edit suggestions and checks started from the chat; `auto` is for checks that run by themselves. */
export interface WriteModels {
  chat(): string
  auto(): string
  setChat(model: string): Promise<void>
  setAuto(model: string): Promise<void>
  /** Suggestions for the pickers; any id can be typed. */
  suggestions: string[]
}

/** What the Write page needs from the outside: the article service, the chat, and the articles' chat port. */
export interface WriteServices {
  /** The model backend in use ("anthropic", "claude-cli" and so on), which decides what a failed call tells the writer to try. */
  backend: string
  service: ArticleService
  store: ArticleStore
  port: WriterChatPort
  /** One chat turn about the article currently open. `model` is the model that answered. */
  chat(message: string, activeArticleId: string | undefined, live?: { onToken?: (token: string) => void; signal?: AbortSignal }): Promise<{ reply: string; model: string; stopped?: boolean }>
  /**
   * Only the recording half of a chat turn, for a message that asks for an edit, a draft or suggestions: what the writer says (comments, decisions,
   * corrections) is kept in the article's record as in any turn, but no reply is written. One model call instead of the whole turn.
   * `recorded` is false when the record could not be made (the edit goes ahead; the page says so).
   */
  record(message: string, activeArticleId: string | undefined, live?: { signal?: AbortSignal }): Promise<{ model: string; recorded: boolean; stopped?: boolean }>
  /** What a message asks for, read by the model (the automatic-checks model, which is the cheaper one): change the text, suggest changes, or just answer. A failure reads as an answer. */
  intent(message: string, context: { articleHasText: boolean; lastReply?: string }, live?: { signal?: AbortSignal }): Promise<WriterIntent>
  /** Reads the pages a message pointed to, for a change that should follow them. `block` is their text for the model's instruction; each page that could not be read is in `failed` with why. */
  readReferences(urls: string[]): Promise<{ block: string; failed: { url: string; reason: string }[] }>
  models: WriteModels
  permissions: { get(): Promise<WritePermissions>; set(p: WritePermissions): Promise<void> }
  /** Dollars spent on model calls in this browser so far (counts toward the cap). */
  spentUsd(): number
  /** What has been spent and used so far, and a way to hear about every new model call. */
  spend: { snapshot(): SpendSnapshot; subscribe(listener: () => void): () => void }
  /** Whether this page can search the web for sources (a proxy and a search key are set up). */
  canSearch: boolean
  /** Whether this page can read a web page by its address (a proxy is set up). */
  canReadPages: boolean
  /** Asks the writer for a folder on their computer to take source files from. Absent where the browser cannot (Safari, Firefox). Resolves to undefined when cancelled. */
  pickFolder?: () => Promise<FolderReader | undefined>
  /** The writer's GitHub token, for reading a private repository. Read when a repository is added, so a change in Settings applies at once. */
  readonly githubToken?: string
  /** What the host is called in Settings text: 'browser' (default) or 'app'. */
  hostName?: 'browser' | 'app'
  /** The host's own way to make a network call to GitHub, for a host whose page cannot call it directly (the desktop webview). Absent: the page's own fetch. */
  readonly githubFetch?: typeof fetch
  /** Saves the GitHub token. Present only where Write keeps the token itself (a host with no connection screen of its own for it). */
  setGithubToken?: (token: string | undefined) => Promise<void>
  /** Saves a file the writer asked for (an export). Absent where a download link does the job (a browser tab). */
  saveFile?: (name: string, text: string) => Promise<void>
  /** How Write has been used here: one small record per background job, kept only in this browser or app. */
  activity: ActivityLog
  /** Dollars and calls so far for each kind of call, biggest first. */
  spendByType(): { id: string; usd: number; calls: number }[]
  /** Deletes every article, version, comment, source and saved setting, the chat and the spending record, and puts the models back to their defaults. The connection (the key) is kept. */
  deleteAllData(): Promise<void>
}

const SESSION_ID = 'write'
const CHAT_MODEL_KEY = 'writer:model-chat'
const AUTO_MODEL_KEY = 'writer:model-auto'
const GITHUB_TOKEN_KEY = 'writer:github-token'

/** The model client, remembering the message of the last error it raised: a failed chat turn is told to the person with that message. */
function rememberErrors(inner: ILLMClient, remember: (message: string) => void): ILLMClient {
  const note = (e: unknown): never => { remember(e instanceof Error ? e.message : String(e)); throw e }
  return {
    ...(inner.nativeToolCalls === false ? { nativeToolCalls: false as const } : {}),
    async *callChat(messages, options) {
      try { yield* inner.callChat(messages, options) } catch (e) { note(e) }
    },
    callChatSync: (messages, options) => inner.callChatSync(messages, options).catch(note),
    callChatStructured: (messages, tools, options) => inner.callChatStructured(messages, tools, options).catch(note),
  }
}

export async function assembleWriteServices(parts: {
  store: ArticleStore
  llm: ILLMClient
  /** Where the model defaults come from: the backend, and the model from the visitor's settings if they set one. */
  backend?: string
  configuredModel?: string
  buildAssistant: (port: WriterChatPort, llm: ILLMClient, model: string) => Promise<PersonalAssistant>
  /** Reads a web page as text. Absent when this browser cannot reach pages. */
  fetchWeb?: (url: string) => Promise<string>
  /** Searches the web for pages that might back a claim. Absent when no search is set up. */
  searchWeb?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>
  pickFolder?: () => Promise<FolderReader | undefined>
  githubToken?: string
  /** Write keeps the GitHub token in its own settings (the host has no place for it), and Settings shows a field for it. */
  keepGithubToken?: boolean
  hostName?: 'browser' | 'app'
  githubFetch?: typeof fetch
  saveFile?: (name: string, text: string) => Promise<void>
}): Promise<WriteServices> {
  const { store } = parts
  const backend = parts.backend ?? 'anthropic'
  const defaults = defaultWriteModels(backend, parts.configuredModel)
  const saved = async (key: string, fallback: string): Promise<string> => {
    const v = await store.getSetting(key)
    return typeof v === 'string' && v.trim() ? v : fallback
  }
  let chatModel = await saved(CHAT_MODEL_KEY, defaults.chat)
  let autoModel = await saved(AUTO_MODEL_KEY, defaults.auto)

  let githubToken = parts.githubToken
  if (parts.keepGithubToken) {
    const kept = await store.getSetting(GITHUB_TOKEN_KEY)
    if (typeof kept === 'string' && kept.trim()) githubToken = kept.trim()
  }

  const meter = await createSpendMeter(store, { backend, model: chatModel })
  let cap = (await loadPermissions(store)).spendCapUsd
  // Every model call, the article steps and the chat alike, goes through the cap.
  let lastModelError: string | undefined
  const llm = rememberErrors(withSpendCap(parts.llm, meter, () => cap), (m) => { lastModelError = m })
  const port = createArticleChatPort(store)
  const service = serializeByArticle(new ArticleService({ store, llm, fetchWeb: parts.fetchWeb, searchWeb: parts.searchWeb, modelFor: (role) => (role === 'writer' ? chatModel : autoModel) }))
  const assistant = await parts.buildAssistant(port, llm, chatModel)

  return {
    backend,
    service,
    store,
    port,
    async chat(message, activeArticleId, live) {
      if (activeArticleId) await port.setActive(activeArticleId)
      const used = chatModel
      lastModelError = undefined
      const result = await assistant.turn(message, { sessionId: SESSION_ID, ...(live?.signal ? { signal: live.signal } : {}), ...(live?.onToken ? { onToken: live.onToken } : {}) })
      if (result.status === 'cancelled') return { reply: 'Stopped.', model: used, stopped: true }
      // A turn that did not finish has no reply. The page says why instead of showing an empty answer: the model's own error when a call failed
      // (the harness wraps it in text about risk checks), otherwise the reason the turn gives.
      const why = lastModelError ?? result.reason
      const hint = modelFailureHint(backend)
      return { reply: result.reply ?? (why ? `I could not answer: ${why.replace(/[.\s]+$/, '')}. ${hint}` : `I could not answer, and the model gave no reason. ${hint}`), model: used }
    },
    async record(message, activeArticleId, live) {
      if (activeArticleId) await port.setActive(activeArticleId)
      const used = chatModel
      const work = recordWriterMessage({ message, port }, llm, chatModel)
      // A stop is honoured at once; the call itself finishes in the background and keeps what the writer said, which is harmless.
      const signal = live?.signal
      const outcome = signal
        ? await Promise.race([work, new Promise<'stopped'>((resolve) => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped'), { once: true }) })])
        : await work
      if (outcome === 'stopped') return { model: used, recorded: false, stopped: true }
      return { model: used, recorded: outcome.status === 'captured' || outcome.status === 'off' }
    },
    intent: (message, context, live) => readWriterIntent({ message, ...context }, llm, autoModel, undefined, live?.signal),
    async readReferences(urls) {
      const failed: { url: string; reason: string }[] = []
      const parts_: string[] = []
      for (const url of urls) {
        if (!parts.fetchWeb) { failed.push({ url, reason: 'no web proxy is set up for reading pages (Settings, Connection)' }); continue }
        try {
          const text = (await parts.fetchWeb(url)).trim()
          if (text) parts_.push(`Page ${url}:\n${text.slice(0, MAX_REFERENCE_CHARS)}`)
          else failed.push({ url, reason: 'the page had no text' })
        } catch (e) {
          failed.push({ url, reason: e instanceof Error ? e.message : String(e) })
        }
      }
      return { block: parts_.length ? `\n\nThe writer pointed to these pages as an example or material for this change; follow or use them as the writer asks:\n\n${parts_.join('\n\n')}` : '', failed }
    },
    models: {
      chat: () => chatModel,
      auto: () => autoModel,
      async setChat(model) {
        const m = model.trim()
        if (!m) return
        chatModel = m
        assistant.setModel?.(m)
        await store.setSetting(CHAT_MODEL_KEY, m)
      },
      async setAuto(model) {
        const m = model.trim()
        if (!m) return
        autoModel = m
        await store.setSetting(AUTO_MODEL_KEY, m)
      },
      suggestions: suggestedModels(backend),
    },
    permissions: {
      get: () => loadPermissions(store),
      async set(p) {
        await savePermissions(store, p)
        cap = p.spendCapUsd
      },
    },
    canSearch: parts.searchWeb !== undefined,
    canReadPages: parts.fetchWeb !== undefined,
    pickFolder: parts.pickFolder,
    hostName: parts.hostName,
    githubFetch: parts.githubFetch,
    get githubToken() { return githubToken },
    setGithubToken: parts.keepGithubToken
      ? async (token) => {
          githubToken = token?.trim() || undefined
          await store.setSetting(GITHUB_TOKEN_KEY, githubToken ?? '')
        }
      : undefined,
    saveFile: parts.saveFile,
    async deleteAllData() {
      // The conversation Write held with the assistant goes too (a leftover transcript is scratch state, so a failure there is not fatal).
      try { await assistant.clearSession(SESSION_ID) } catch { /* nothing to remove */ }
      if (store.clearAll) await store.clearAll()
      else for (const a of await store.list()) await store.remove(a.id)
      meter.reset()
      cap = undefined
      chatModel = defaults.chat
      autoModel = defaults.auto
      assistant.setModel?.(defaults.chat)
      githubToken = parts.githubToken
    },
    activity: createActivityLog(store),
    spentUsd: () => meter.spentUsd(),
    spend: { snapshot: () => meter.snapshot(), subscribe: (l) => meter.subscribe(l) },
    spendByType: () => Object.entries(meter.byType()).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.usd - a.usd),
  }
}

/** The proxy that reads pages and searches: its address and access token (the token may be empty, as on the hosted one). */
export interface WebProxy { url: string; token: string }

/** Page reading and search through the proxy, sharing one set of search results so a found page can be read. Search needs the visitor's search key too. */
function proxyWeb(config: AssistantConfig, proxy: WebProxy): { fetchWeb: (url: string) => Promise<string>; searchWeb?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]> } {
  const ctx = createProxyWebTools({ ...config, proxyUrl: proxy.url, authToken: proxy.token })
  return {
    fetchWeb: pageReader(ctx),
    searchWeb: config.braveApiKey ? ctx.search : undefined,
  }
}

/**
 * What the host (a browser tab, the desktop app) supplies to Write: where articles are kept, how model calls are made, and what it can reach.
 * Everything else about Write is the same on every host, so a host is only this.
 */
export interface WritePlatform {
  store: ArticleStore
  llm: ILLMClient
  /** Reads a web page as text. Absent where pages cannot be read. */
  fetchWeb?: (url: string) => Promise<string>
  /** Searches the web for pages that might back a claim. Absent when no search is set up. */
  searchWeb?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>
  /** Asks the writer for a folder to take source files or a repository from. Absent where the host has no folder access. */
  pickFolder?: () => Promise<FolderReader | undefined>
  /** The writer's GitHub token, for a private repository. */
  githubToken?: string
  /** Write keeps the GitHub token in its own settings and shows a field for it in Settings (the host has no connection screen for it). */
  keepGithubToken?: boolean
  /** What the host is called in Settings text. Default 'browser'. */
  hostName?: 'browser' | 'app'
  /** The host's own way to make a network call to GitHub. Absent: the page's own fetch. */
  githubFetch?: typeof fetch
  /** Saves a file the writer asked for. Absent where a download link does the job. */
  saveFile?: (name: string, text: string) => Promise<void>
}

/** Write on any host: the connection (model and key) and what the host can do. */
export function createWriteServicesFor(config: AssistantConfig, platform: WritePlatform): Promise<WriteServices> {
  return assembleWriteServices({
    ...platform,
    backend: config.llmBackend,
    configuredModel: config.model,
    buildAssistant: (port, capped, model) => PersonalAssistant.create({ ...buildAssistantOptions({ ...config, model }, { llmClient: capped, features: WEB_FEATURES }), writerChat: port }),
  })
}

/** How much of a page the writer pointed to goes into the instruction. */
const MAX_REFERENCE_CHARS = 8000

/** Articles kept in the webview's or browser's IndexedDB. Both hosts start with this. */
export function indexedDbArticleStore(): ArticleStore {
  const store = createMemoryAdapterArticleStore(new IndexedDBAdapter({ namespace: 'aielia-write' }))
  return import.meta.env.DEV ? mirrorStore(store) : store
}

/** Dev server only: copies every save and removal to vite.write.config.ts's /__mirror so a watcher can read the article. */
function mirrorStore(store: ArticleStore): ArticleStore {
  const post = (kind: string, id: string, bundle?: unknown) => {
    void fetch('/__mirror', { method: 'POST', body: JSON.stringify({ kind, id, bundle }) }).catch(() => undefined)
  }
  const SECRET = /token|key|secret|password/i
  return {
    ...store,
    async save(id, bundle) {
      await store.save(id, bundle)
      post('save', id, bundle)
    },
    async remove(id) {
      await store.remove(id)
      post('remove', id)
    },
    async setSetting(key, value) {
      await store.setSetting(key, value)
      if (!SECRET.test(key)) post('setting', key, value)
    },
  }
}

/** A plain browser tab: IndexedDB storage, the visitor's own key, no file or shell tools. */
export function webWritePlatform(config: AssistantConfig, webProxy?: WebProxy, githubToken?: string): WritePlatform {
  // A plain browser tab cannot fetch arbitrary pages (CORS, and no DNS to check the address). Pages are read through the proxy
  // when the visitor set one up; otherwise the writer pastes the passage.
  const web = webProxy ? proxyWeb(config, webProxy) : undefined
  return {
    store: indexedDbArticleStore(),
    // A test build (VITE_E2E=1) can hand the page its own model client; a production bundle cannot reach this.
    llm: getAssistantTestHooks()?.makeLlmClient?.(config) ?? createLlmClient(config, { claudeCli: () => undefined }),
    fetchWeb: web?.fetchWeb,
    searchWeb: web?.searchWeb,
    pickFolder: browserFolderPicker(),
    githubToken,
  }
}

/** The real thing in a browser tab. */
export function createWriteServices(config: AssistantConfig, webProxy?: WebProxy, githubToken?: string): Promise<WriteServices> {
  return createWriteServicesFor(config, webWritePlatform(config, webProxy, githubToken))
}
