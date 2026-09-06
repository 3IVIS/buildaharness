import { describe, it, expect } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import type { TraceEvent } from './trace-events.js'

/** In-memory FsBackend so `fileTools` is configured and the tool loop actually runs. */
function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>([['/ws/note.txt', 'hello from a seeded file']])
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {},
    async readDir(dir) {
      const prefix = `${dir}/`
      return [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length))
    },
  }
}

describe('createScriptedLLMClient', () => {
  it('auto-answers classifyTurnIntent and plays back a scripted final answer', async () => {
    const llm = createScriptedLLMClient({ responses: ['The answer is 84.'] })
    const assistant = new PersonalAssistant({ llmClient: llm, fileTools: { backend: makeFakeBackend(), workspaceRoot: '/ws' } })

    const result = await assistant.turn('What is 12 x 7?')

    expect(result.status).toBe('ok')
    expect(result.reply).toBe('The answer is 84.')
  })

  it('respects a classify() override for the triviality fast path', async () => {
    const llm = createScriptedLLMClient({
      streamChunks: ['Tokyo is UTC+9.'],
      classify: () => ({ isTrivial: true }),
    })
    const assistant = new PersonalAssistant({ llmClient: llm })

    const result = await assistant.turn('What timezone is Tokyo in?')

    expect(result.status).toBe('ok')
    expect(result.reply).toBe('Tokyo is UTC+9.')
    expect(result.harnessSkipped).toBe(true)
  })
})

describe('AssistantTurnResult.proposerKind', () => {
  const script = () => ({
    responses: [
      { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'note.txt' } }] },
      'The file says: hello from a seeded file',
    ],
  })

  it('flag OFF → posthoc, and a proposer_selected trace event is emitted', async () => {
    const events: TraceEvent[] = []
    const assistant = new PersonalAssistant({
      llmClient: createScriptedLLMClient(script()),
      fileTools: { backend: makeFakeBackend(), workspaceRoot: '/ws' },
      onTrace: (e) => events.push(e),
    })

    const result = await assistant.turn('Read note.txt and tell me what it says')

    expect(result.status).toBe('ok')
    expect(result.proposerKind).toBe('posthoc')
    expect(events).toContainEqual({ kind: 'proposer_selected', proposerKind: 'posthoc' })
  })

  it('flag ON (non-batch) → flat-oneloop, with identical reply text', async () => {
    const off = new PersonalAssistant({
      llmClient: createScriptedLLMClient(script()),
      fileTools: { backend: makeFakeBackend(), workspaceRoot: '/ws' },
    })
    const on = new PersonalAssistant({
      llmClient: createScriptedLLMClient(script()),
      fileTools: { backend: makeFakeBackend(), workspaceRoot: '/ws' },
      oneLoopMode: 'enabled',
    })

    const offResult = await off.turn('Read note.txt and tell me what it says')
    const onResult = await on.turn('Read note.txt and tell me what it says')

    expect(offResult.proposerKind).toBe('posthoc')
    expect(onResult.proposerKind).toBe('flat-oneloop')
    expect(onResult.reply).toBe(offResult.reply)
  })
})
