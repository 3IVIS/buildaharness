import {
  ArticleService,
  PersonalAssistant,
  WEB_FEATURES,
  buildAssistantOptions,
  createArticleChatPort,
  createLlmClient,
  createMemoryAdapterArticleStore,
  createSpendMeter,
  loadPermissions,
  savePermissions,
  withSpendCap,
  type ArticleStore,
  type WritePermissions,
  type AssistantConfig,
  type WriterChatPort,
} from '@buildaharness/aielia'
import { IndexedDBAdapter, type ILLMClient } from '@buildaharness/runtime'

/** What the Write page needs from the outside: the article service, the chat, and the articles' chat port. */
export interface WriteServices {
  service: ArticleService
  store: ArticleStore
  port: WriterChatPort
  /** One chat turn about the article currently open. */
  chat(message: string, activeArticleId: string | undefined): Promise<string>
  permissions: { get(): Promise<WritePermissions>; set(p: WritePermissions): Promise<void> }
  /** Dollars spent on model calls in this browser so far (counts toward the cap). */
  spentUsd(): number
}

const SESSION_ID = 'write'

export async function assembleWriteServices(parts: { store: ArticleStore; llm: ILLMClient; model?: string; backend?: string; buildAssistant: (port: WriterChatPort, llm: ILLMClient) => Promise<PersonalAssistant> }): Promise<WriteServices> {
  const { store } = parts
  const meter = await createSpendMeter(store, { backend: parts.backend, model: parts.model })
  let cap = (await loadPermissions(store)).spendCapUsd
  // Every model call - the article steps and the chat - goes through the cap.
  const llm = withSpendCap(parts.llm, meter, () => cap)
  const port = createArticleChatPort(store)
  const service = new ArticleService({ store, llm, model: parts.model, modelName: parts.model })
  const assistant = await parts.buildAssistant(port, llm)
  return {
    service,
    store,
    port,
    async chat(message, activeArticleId) {
      if (activeArticleId) await port.setActive(activeArticleId)
      const result = await assistant.turn(message, { sessionId: SESSION_ID })
      return result.reply ?? ''
    },
    permissions: {
      get: () => loadPermissions(store),
      async set(p) {
        await savePermissions(store, p)
        cap = p.spendCapUsd
      },
    },
    spentUsd: () => meter.spentUsd(),
  }
}

/** The real thing: IndexedDB storage, the visitor's own key, a plain browser (no file or shell tools). */
export function createWriteServices(config: AssistantConfig): Promise<WriteServices> {
  const memory = new IndexedDBAdapter({ namespace: 'aielia-write' })
  const store = createMemoryAdapterArticleStore(memory)
  const llm = createLlmClient(config, { claudeCli: () => undefined })
  return assembleWriteServices({
    store,
    llm,
    model: config.model,
    backend: config.llmBackend,
    buildAssistant: (port, capped) => PersonalAssistant.create({ ...buildAssistantOptions(config, { llmClient: capped, features: WEB_FEATURES }), writerChat: port }),
  })
}
