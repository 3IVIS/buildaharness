import type { ILLMClient } from '@buildaharness/runtime'
import { PersonalAssistant, WEB_FEATURES, buildAssistantOptions, createMemoryArticleStore } from '@buildaharness/aielia'
import { toAssistantConfig } from './write-config'
import { assembleWriteServices, type WriteServices } from './write-services'
import { buildSampleBundle, buildSampleChat, SAMPLE_ARTICLE_ID } from './sample-article'
import { CHAT_LINES_KEY } from './WriteApp'

/** The backend name of the sample: what a failed step reads to say "this is a sample" rather than "check your key". */
export const SAMPLE_BACKEND = 'sample'

/** What the page says wherever a model would have answered. */
export const SAMPLE_MESSAGE = 'This is only a sample, so Aielia is not answering here. Add your AI key to try this on your own article'

/** A model client that never reaches a model: every call refuses with the sample message. Nothing leaves the browser. */
export function sampleLlm(): ILLMClient {
  const refuse = (): never => { throw new Error(SAMPLE_MESSAGE) }
  return {
    async *callChat() { refuse() },
    callChatSync: async () => refuse(),
    callChatStructured: async () => refuse(),
  }
}

/**
 * Write with no key: the real editor on a recorded sample article held in memory only (nothing is written to this browser), where hand edits work and
 * everything that would call a model says it is a sample. Choosing to add a key leaves this and opens the visitor's own, empty workspace.
 */
export async function createSampleServices(): Promise<WriteServices> {
  const store = createMemoryArticleStore()
  await store.save(SAMPLE_ARTICLE_ID, buildSampleBundle())
  // The recorded chat is what the page loads as the earlier conversation.
  await store.setSetting(CHAT_LINES_KEY, buildSampleChat())
  const config = toAssistantConfig(undefined, {})
  const base = await assembleWriteServices({
    store,
    llm: sampleLlm(),
    backend: SAMPLE_BACKEND,
    buildAssistant: (port, capped, model) => PersonalAssistant.create({ ...buildAssistantOptions({ ...config, model }, { llmClient: capped, features: WEB_FEATURES }), writerChat: port }),
  })
  return {
    ...base,
    // A chat message is answered at once with the sample message, and nothing the writer says is recorded.
    chat: async () => ({ reply: `${SAMPLE_MESSAGE}.`, model: SAMPLE_BACKEND }),
    record: async () => ({ model: SAMPLE_BACKEND, recorded: false }),
  }
}
