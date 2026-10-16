import {
  ArticleService,
  PersonalAssistant,
  WEB_FEATURES,
  buildAssistantOptions,
  createArticleChatPort,
  createLlmClient,
  createMemoryAdapterArticleStore,
  type ArticleStore,
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
}

const SESSION_ID = 'write'

export function assembleWriteServices(parts: { store: ArticleStore; llm: ILLMClient; model?: string; buildAssistant: (port: WriterChatPort) => Promise<PersonalAssistant> }): Promise<WriteServices> {
  const { store, llm } = parts
  const port = createArticleChatPort(store)
  const service = new ArticleService({ store, llm, model: parts.model, modelName: parts.model })
  return parts.buildAssistant(port).then((assistant) => ({
    service,
    store,
    port,
    async chat(message: string, activeArticleId: string | undefined): Promise<string> {
      if (activeArticleId) await port.setActive(activeArticleId)
      const result = await assistant.turn(message, { sessionId: SESSION_ID })
      return result.reply ?? ''
    },
  }))
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
    buildAssistant: (port) => PersonalAssistant.create({ ...buildAssistantOptions(config, { llmClient: llm, features: WEB_FEATURES }), writerChat: port }),
  })
}
