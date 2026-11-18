import type { ILLMClient } from '@buildaharness/runtime'
import { FakeEmailProvider, OfflineEmailSession, generateSyntheticMailbox, type Folder, type Message, type ScoredTodo } from '@buildaharness/aielia'

/** The backend name of the sample: what a failed step reads to say "this is a sample" rather than "check your key". */
export const SAMPLE_BACKEND = 'sample'

/** What the page says wherever a model would have answered. */
export const SAMPLE_MESSAGE = 'This is only a sample mailbox, so Aielia is not answering here. Connect your mail and your AI to try this on your own mail'

/** A model client that never reaches a model: every call refuses with the sample message. Nothing leaves the browser. */
export function sampleLlm(): ILLMClient {
  const refuse = (): never => { throw new Error(SAMPLE_MESSAGE) }
  return {
    async *callChat() { refuse() },
    callChatSync: async () => refuse(),
    callChatStructured: async () => refuse(),
  }
}

export interface SampleMailbox {
  provider: FakeEmailProvider
  llm: ILLMClient
  folders: Folder[]
  /** The Inbox, newest first. */
  inbox: Message[]
  /** The to-do list of the sample, from the generator's own labels (no model is called). */
  todo: ScoredTodo[]
  /** A chat message is answered at once with the sample message; nothing is recorded. */
  ask: (text: string) => Promise<{ reply: string; model: string }>
}

/**
 * The sample mailbox: the invented synthetic mailbox over the in-memory fake provider (no network, nothing stored in this browser), where reading
 * works and everything that would call a model says it is a sample.
 */
export async function createSampleMailbox(): Promise<SampleMailbox> {
  const mailbox = generateSyntheticMailbox()
  const provider = new FakeEmailProvider(mailbox)
  const session = new OfflineEmailSession({ mailbox, now: () => '2026-11-02T00:00:00.000Z' })
  await session.catchUp('all')
  const todo = (await session.todo()).items
  const folders = await provider.listFolders()
  const inboxFolder = folders.find((f) => f.kind === 'inbox')
  const page = inboxFolder ? await provider.listMessages(inboxFolder.id, { limit: 200 }) : { items: [] as Message[] }
  const inbox = [...page.items].sort((a, b) => b.date.localeCompare(a.date))
  return { provider, llm: sampleLlm(), folders, inbox, todo, ask: async () => ({ reply: `${SAMPLE_MESSAGE}.`, model: SAMPLE_BACKEND }) }
}
