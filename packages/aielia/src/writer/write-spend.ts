import type { ChatMessage } from '@buildaharness/runtime'

/**
 * What a model call was for, so the page can show where the writer's money went. The call type is read from the opening words of the
 * call's system prompt (each step of the article service has its own); a call with none of these is the chat answering the writer.
 * A test runs every step and fails if one is not recognised here, so a reworded prompt cannot silently move its cost to "chat".
 */
export interface CallType {
  id: string
  label: string
  /** The start of the step's system prompt. */
  marker: string
}

export const CALL_TYPES: readonly CallType[] = [
  { id: 'claims', label: 'Finding claims', marker: 'You read parts of an article and list the claims' },
  { id: 'support', label: 'Checking claims against sources', marker: 'You check whether a claim from an article' },
  { id: 'consistency', label: 'Checking the article against itself and its sources', marker: 'You check an article for two kinds of problem' },
  { id: 'repo_search', label: 'Looking things up in a repository', marker: 'You check claims from an article against a software repository' },
  { id: 'style_derive', label: 'Drawing a style sheet from the text', marker: 'You read an article and describe it so a co-writer' },
  { id: 'impact', label: 'Judging what an edit affects', marker: 'You help a writer keep an article consistent' },
  { id: 'source_change', label: 'Judging a changed source', marker: 'A source an article relies on was read again' },
  { id: 'source_links', label: 'Placing a new source', marker: 'A writer added a source to an article' },
  { id: 'links', label: 'Finding links between sections', marker: 'You map how the sections' },
  { id: 'edits', label: 'Suggesting edits', marker: 'You propose edits to an article' },
  { id: 'outline', label: 'Reworking the outline', marker: 'You rework the outline of an article' },
  { id: 'ideas', label: 'Suggesting ideas', marker: 'You help a writer collect ideas' },
  { id: 'capture', label: 'Remembering comments and corrections', marker: 'A writer is working with an assistant' },
]

export const CHAT_CALL: CallType = { id: 'chat', label: 'Chat', marker: '' }

export function classifyCall(messages: readonly ChatMessage[]): CallType {
  const system = messages.find((m) => m.role === 'system')
  const text = system?.content ?? ''
  return CALL_TYPES.find((t) => text.startsWith(t.marker)) ?? CHAT_CALL
}

export function callTypeLabel(id: string): string {
  return [...CALL_TYPES, CHAT_CALL].find((t) => t.id === id)?.label ?? id
}
