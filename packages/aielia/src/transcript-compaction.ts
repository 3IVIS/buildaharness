import type { ChatMessage } from '@buildaharness/runtime'
import { defangUntrustedTags } from './trust-tagging.js'

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
export const SUMMARY_HEADER = '[Earlier conversation summary]'

/** The older/recent split when the transcript is long enough to compact, else null. */
function splitForCompaction(transcript: ChatMessage[]): { older: ChatMessage[]; recent: ChatMessage[] } | null {
  const overThreshold = transcript.length > MAX_TRANSCRIPT_MESSAGES || totalChars(transcript) > MAX_TRANSCRIPT_CHARS
  if (!overThreshold || transcript.length <= KEEP_RECENT) return null
  return { older: transcript.slice(0, transcript.length - KEEP_RECENT), recent: transcript.slice(transcript.length - KEEP_RECENT) }
}

const MAX_SUMMARY_CHARS = 8000

function truncatedSummary(older: ChatMessage[]): ChatMessage {
  const summaryLines: string[] = []
  for (const m of older) {
    // An earlier summary is already in this form: carry its lines over whole instead of cutting the entire
    // summary to one preview (which dropped everything but its first lines at the second compaction).
    if (m.role === 'assistant' && m.content.startsWith(SUMMARY_HEADER)) {
      summaryLines.push(...m.content.slice(SUMMARY_HEADER.length).split('\n').filter((line) => line !== ''))
    } else {
      summaryLines.push(`${m.role}: ${defangUntrustedTags(m.content).slice(0, SUMMARY_PREVIEW_CHARS)}`)
    }
  }
  // Bounded growth: the oldest lines go first once the summary is over its cap.
  let total = summaryLines.reduce((sum, line) => sum + line.length + 1, 0)
  while (total > MAX_SUMMARY_CHARS && summaryLines.length > 1) total -= summaryLines.shift()!.length + 1
  return { role: 'assistant', content: `${SUMMARY_HEADER}\n${summaryLines.join('\n')}` }
}

/** The messages compaction would drop for `transcript` right now (the older part), or null when it would not compact. M3's pre-compaction flush reads exactly these. Same threshold, no new trigger. */
export function messagesAboutToBeCompacted(transcript: ChatMessage[]): ChatMessage[] | null {
  return splitForCompaction(transcript)?.older ?? null
}

export function compactTranscript(transcript: ChatMessage[]): CompactionResult {
  const split = splitForCompaction(transcript)
  if (!split) return { transcript, compacted: false }
  return { transcript: [truncatedSummary(split.older), ...split.recent], compacted: true }
}

/**
 * Same thresholds and same messages kept as `compactTranscript`, but the older part is summarized by `summarize`
 * (semantic-compaction.ts) instead of truncated to 200 characters each. A `summarize` that returns null or throws
 * falls back to the truncated form, so this can never lose more than `compactTranscript` would have.
 */
export async function compactTranscriptSemantic(
  transcript: ChatMessage[],
  summarize: (older: ChatMessage[]) => Promise<string | null>,
): Promise<CompactionResult> {
  const split = splitForCompaction(transcript)
  if (!split) return { transcript, compacted: false }
  let summary: string | null = null
  try {
    summary = await summarize(split.older)
  } catch {
    /* fall back to the truncated form */
  }
  const message: ChatMessage = summary ? { role: 'assistant', content: `${SUMMARY_HEADER}\n${defangUntrustedTags(summary)}` } : truncatedSummary(split.older)
  return { transcript: [message, ...split.recent], compacted: true }
}
