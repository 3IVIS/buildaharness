import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { FsBackend } from '@buildaharness/runtime'
import { PersonalAssistant, createScriptedLLMClient } from '@buildaharness/aielia'
import { shouldRenderAskQuestionCard } from './ask-question-render'

const QUESTION = { id: 'q1', question: 'Which language?', options: [{ label: 'TypeScript' }, { label: 'Python' }] }

describe('shouldRenderAskQuestionCard', () => {
  it('renders the card for a populated needs_clarification result', () => {
    expect(
      shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: 'p1', questions: [QUESTION] }),
    ).toBe(true)
  })

  it('falls back to the plain escalation path when status is not needs_clarification', () => {
    expect(
      shouldRenderAskQuestionCard({ status: 'escalated', pendingClarificationId: 'p1', questions: [QUESTION] }),
    ).toBe(false)
  })

  it('falls back when questions is absent (today\'s plain escalation shape)', () => {
    expect(shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: 'p1', questions: undefined })).toBe(false)
  })

  it('falls back when questions is an empty array', () => {
    expect(shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: 'p1', questions: [] })).toBe(false)
  })

  it('falls back when pendingClarificationId is missing — nothing to resume against', () => {
    expect(
      shouldRenderAskQuestionCard({ status: 'needs_clarification', pendingClarificationId: undefined, questions: [QUESTION] }),
    ).toBe(false)
  })
})

// A REAL result: an unmocked PersonalAssistant halting on its step budget with ask mode on. The card is chosen from
// `{ status, questions, pendingClarificationId }` alone, so this is what proves the assistant's real output is renderable
// (the other cases above use hand-built results).
describe('shouldRenderAskQuestionCard on a genuine assistant result', () => {
  it('chooses the interactive card for a real needs_clarification, whose question has options the card can show', async () => {
    const files = new Map([['/ws/note.txt', 'hello']])
    const backend: FsBackend = {
      async readTextFile(p) { return files.get(p) },
      async writeTextFile(p, c) { files.set(p, c) },
      async removeFile(p) { files.delete(p) },
      async mkdir() {},
      async readDir() { return ['note.txt'] },
    }
    const readNote = { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'note.txt' } }] }
    const assistant = new PersonalAssistant({
      llmClient: createScriptedLLMClient({ responses: [readNote, readNote, readNote, readNote, readNote, readNote, 'done'], streamChunks: ['done'] }),
      fileTools: { backend, workspaceRoot: '/ws' },
      checkpointStore: new InMemoryAdapter({ scope: 'thread', namespace: 'ui-real-ask' }),
      oneLoopMode: 'enabled',
      goalGraphSuggestMode: 'disabled',
      askMode: 'enabled',
      maxSteps: 2,
    })
    const result = await assistant.turn('Keep re-reading note.txt until you are certain of every word', { sessionId: 'ui' })
    expect(result.status).toBe('needs_clarification')
    expect(shouldRenderAskQuestionCard(result)).toBe(true)
    const q = result.questions![0]
    expect(q.question.length).toBeGreaterThan(0)
    expect(q.options!.length).toBeGreaterThanOrEqual(2)
    expect(q.options!.every((o) => o.label.length > 0)).toBe(true)
  })
})
