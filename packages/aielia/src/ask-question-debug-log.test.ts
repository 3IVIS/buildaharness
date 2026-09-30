import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { FsBackend } from '@buildaharness/runtime'
import type { AskQuestion } from '@buildaharness/harness'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { formatAskQuestions } from './ask-response-format.js'

const ROOT = '/ws'
const backend = (): FsBackend => {
  const files = new Map([[`${ROOT}/note.txt`, 'hello from a seeded file']])
  return {
    async readTextFile(p) { return files.get(p) },
    async writeTextFile(p, c) { files.set(p, c) },
    async removeFile(p) { files.delete(p) },
    async mkdir() {},
    async readDir() { return ['note.txt'] },
  }
}
const readNote = { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'note.txt' } }] }

describe('formatAskQuestions', () => {
  it('renders each question and its numbered options, with descriptions when present', () => {
    const qs: AskQuestion[] = [
      { id: 'q1', question: 'How should I proceed?', options: [{ label: 'Continue with 10 more steps' }, { label: 'Stop', description: 'summarize what is done' }] },
      { id: 'q2', question: 'Anything else?' },
    ]
    expect(formatAskQuestions(qs)).toBe('QUESTION: How should I proceed?\n  1. Continue with 10 more steps\n  2. Stop — summarize what is done\nQUESTION: Anything else?')
  })
})

describe('a structured question in the debug log', () => {
  const run = async (askMode: 'enabled' | 'disabled') => {
    const lines: string[] = []
    const assistant = new PersonalAssistant({
      llmClient: createScriptedLLMClient({ responses: [readNote, readNote, readNote, readNote, readNote, readNote, 'Out of steps.'] }),
      fileTools: { backend: backend(), workspaceRoot: ROOT },
      checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'c' }),
      oneLoopMode: 'enabled',
      goalGraphSuggestMode: 'disabled',
      askMode,
      maxSteps: 2,
      onDebugLog: (e) => { if (e.kind === 'assistant_reply') lines.push(e.content) },
    })
    const result = await assistant.turn('Keep re-reading note.txt until you are certain of every word', { sessionId: 's' })
    return { result, lines }
  }

  it('with ask mode on, a budget halt is a needs_clarification whose debug line carries the question and its options (it used to read "(no reply)")', async () => {
    const { result, lines } = await run('enabled')
    expect(result.status).toBe('needs_clarification')
    expect(lines.at(-1)).toContain('QUESTION:')
    expect(lines.at(-1)).toContain('Continue')
    expect(lines.at(-1)).not.toContain('(no reply)')
  })

  it('with ask mode off, the same halt is a plain escalation and its debug line is unchanged', async () => {
    const { result, lines } = await run('disabled')
    expect(result.status).toBe('escalated')
    expect(lines.at(-1)).not.toContain('QUESTION:')
  })
})
