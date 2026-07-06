import type { ChatMessage } from '@buildaharness/runtime'

// PersonalAssistant's persisted transcript only ever holds 'user'/'assistant'
// text messages (see assistant.ts's memory.set calls) — the tool-loop's own
// 'tool' role messages are transient and never written to `this.memory`, so
// cutting the transcript at any message boundary can never orphan a tool
// result from its tool_use call.
const MAX_TRANSCRIPT_MESSAGES = 40
const MAX_TRANSCRIPT_CHARS = 20000
const KEEP_RECENT = 10
const SUMMARY_PREVIEW_CHARS = 200

export interface CompactionResult {
  transcript: ChatMessage[]
  compacted: boolean
}

function totalChars(transcript: ChatMessage[]): number {
  return transcript.reduce((sum, m) => sum + m.content.length, 0)
}

/**
 * Collapses the oldest messages beyond the most recent `KEEP_RECENT` into one
 * synthetic summary message once the transcript crosses a message-count or
 * char-count threshold. Deliberately a truncated concatenation, not an LLM
 * summary — keeps compaction free instead of costing an extra call every time
 * a long session crosses the threshold.
 */
export function compactTranscript(transcript: ChatMessage[]): CompactionResult {
  const overThreshold = transcript.length > MAX_TRANSCRIPT_MESSAGES || totalChars(transcript) > MAX_TRANSCRIPT_CHARS
  if (!overThreshold || transcript.length <= KEEP_RECENT) {
    return { transcript, compacted: false }
  }

  const older = transcript.slice(0, transcript.length - KEEP_RECENT)
  const recent = transcript.slice(transcript.length - KEEP_RECENT)

  const summaryLines = older.map(m => `${m.role}: ${m.content.slice(0, SUMMARY_PREVIEW_CHARS)}`)
  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: `[Earlier conversation summary]\n${summaryLines.join('\n')}`,
  }

  return { transcript: [summaryMessage, ...recent], compacted: true }
}
