import {
  ArticleService,
  PersonalAssistant,
  WEB_FEATURES,
  buildAssistantOptions,
  createArticleChatPort,
  createLlmClient,
  createMemoryAdapterArticleStore,
  createSpendMeter,
  executeWebTool,
  defaultWriteModels,
  loadPermissions,
  savePermissions,
  suggestedModels,
  withSpendCap,
  type ArticleStore,
  type AssistantConfig,
  type WritePermissions,
  type WriterChatPort,
} from '@buildaharness/aielia'
import { IndexedDBAdapter, type ILLMClient } from '@buildaharness/runtime'
import { rememberUserUrls } from '../user-urls'
import { createProxyWebTools } from '../web-context'

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
  service: ArticleService
  store: ArticleStore
  port: WriterChatPort
  /** One chat turn about the article currently open. `model` is the model that answered. */
  chat(message: string, activeArticleId: string | undefined): Promise<{ reply: string; model: string }>
  models: WriteModels
  permissions: { get(): Promise<WritePermissions>; set(p: WritePermissions): Promise<void> }
  /** Dollars spent on model calls in this browser so far (counts toward the cap). */
  spentUsd(): number
  /** Dollars and calls so far for each kind of call, biggest first. */
  spendByType(): { id: string; usd: number; calls: number }[]
}

const SESSION_ID = 'write'
const CHAT_MODEL_KEY = 'writer:model-chat'
const AUTO_MODEL_KEY = 'writer:model-auto'

export async function assembleWriteServices(parts: {
  store: ArticleStore
  llm: ILLMClient
  /** Where the model defaults come from: the backend, and the model from the visitor's settings if they set one. */
  backend?: string
  configuredModel?: string
  buildAssistant: (port: WriterChatPort, llm: ILLMClient, model: string) => Promise<PersonalAssistant>
  /** Reads a web page as text. Absent when this browser cannot reach pages. */
  fetchWeb?: (url: string) => Promise<string>
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

  const meter = await createSpendMeter(store, { backend, model: chatModel })
  let cap = (await loadPermissions(store)).spendCapUsd
  // Every model call, the article steps and the chat alike, goes through the cap.
  const llm = withSpendCap(parts.llm, meter, () => cap)
  const port = createArticleChatPort(store)
  const service = new ArticleService({ store, llm, fetchWeb: parts.fetchWeb, modelFor: (role) => (role === 'writer' ? chatModel : autoModel) })
  const assistant = await parts.buildAssistant(port, llm, chatModel)

  return {
    service,
    store,
    port,
    async chat(message, activeArticleId) {
      if (activeArticleId) await port.setActive(activeArticleId)
      const used = chatModel
      const result = await assistant.turn(message, { sessionId: SESSION_ID })
      return { reply: result.reply ?? '', model: used }
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
    spentUsd: () => meter.spentUsd(),
    spendByType: () => Object.entries(meter.byType()).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.usd - a.usd),
  }
}

function proxyFetch(config: AssistantConfig): (url: string) => Promise<string> {
  const ctx = createProxyWebTools(config)
  return async (url) => {
    rememberUserUrls(url)
    return (await executeWebTool({ search: ctx.search, fetchImpl: ctx.fetchImpl, dns: ctx.dns }, 'fetch_url', { url })).text
  }
}

/** The real thing: IndexedDB storage, the visitor's own key, a plain browser (no file or shell tools). */
export function createWriteServices(config: AssistantConfig): Promise<WriteServices> {
  const memory = new IndexedDBAdapter({ namespace: 'aielia-write' })
  const store = createMemoryAdapterArticleStore(memory)
  const llm = createLlmClient(config, { claudeCli: () => undefined })
  // A plain browser tab cannot fetch arbitrary pages (CORS, and no DNS to check the address). Pages are read through the proxy
  // when the visitor set one up; otherwise the writer pastes the passage.
  const fetchWeb = config.webBackend === 'proxy' ? proxyFetch(config) : undefined
  return assembleWriteServices({
    fetchWeb,
    store,
    llm,
    backend: config.llmBackend,
    configuredModel: config.model,
    buildAssistant: (port, capped, model) => PersonalAssistant.create({ ...buildAssistantOptions({ ...config, model }, { llmClient: capped, features: WEB_FEATURES }), writerChat: port }),
  })
}
