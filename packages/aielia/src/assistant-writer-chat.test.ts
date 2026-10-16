import { describe, it, expect } from 'vitest'
import { InMemoryAdapter, type ILLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { createMemoryWriterChatPort } from './writer/writer-chat-turn.js'

// Aielia Write, T13: chat-held state reaches the answering model, survives a new session, and is inert without a port.

const CAPTURE_MARKER = 'A writer is working with an assistant on one or more articles'
const ARTICLES = [{ id: 'bakery', title: 'Bakery post' }]

/** Records the system prompt of every call that is not the writer-capture call. */
function recording(inner: ILLMClient, seen: string[]): ILLMClient {
  const note = (messages: { role: string; content: string }[]): void => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? ''
    if (!sys.includes(CAPTURE_MARKER)) seen.push(sys)
  }
  return {
    callChat: (m, o) => { note(m); return inner.callChat(m, o) },
    callChatSync: (m, o) => { note(m); return inner.callChatSync(m, o) },
    callChatStructured: (m, t, o) => { note(m); return inner.callChatStructured(m, t, o) },
  }
}

function build(opts: { memory: InMemoryAdapter; capture: string; seen: string[]; withPort: boolean }): PersonalAssistant {
  const inner = createScriptedLLMClient({ responses: ['ok', 'ok', 'ok'], sideResponses: [[CAPTURE_MARKER, opts.capture]] })
  return new PersonalAssistant({
    llmClient: recording(inner, opts.seen),
    memory: opts.memory,
    ...(opts.withPort ? { writerChat: createMemoryWriterChatPort(opts.memory, () => ARTICLES) } : {}),
  })
}
const mem = () => new InMemoryAdapter({ scope: 'thread', namespace: 'assistant-writer-test' })
const comments = JSON.stringify({ articleId: 'bakery', ops: [{ op: 'add_comment', label: 'C4', reviewer: 'Dana', text: 'Open with the cost section' }, { op: 'add_comment', label: 'C5', reviewer: 'Tom', text: 'Keep the cost section last' }, { op: 'conflict', refs: ['C4', 'C5'] }] })
const nothing = JSON.stringify({ articleId: null, ops: [] })

describe('PersonalAssistant writerChat', () => {
  it('shows the answering model what the writer said in chat, including in a new session', async () => {
    const memory = mem()
    const seen: string[] = []
    await build({ memory, capture: comments, seen, withPort: true }).turn('Reviewer comments: C4 ... C5 ...', { sessionId: 'session-1' })
    expect(seen.at(-1)).toContain('comment C4 (Dana)')
    expect(seen.at(-1)).toContain('IN CONFLICT with C5')

    const seen2: string[] = []
    await build({ memory, capture: nothing, seen: seen2, withPort: true }).turn('Show me what is still open.', { sessionId: 'session-2' })
    expect(seen2.at(-1)).toContain('comment C4 (Dana)')
    expect(seen2.at(-1)).toContain('the writer has not chosen')
  })

  it('adds nothing and makes no capture call without a port', async () => {
    const seen: string[] = []
    await build({ memory: mem(), capture: comments, seen, withPort: false }).turn('Reviewer comments: C4 ... C5 ...', { sessionId: 'session-1' })
    expect(seen.at(-1)).not.toContain('Writer')
    expect(seen.at(-1)).not.toContain('comment C4')
  })
})
