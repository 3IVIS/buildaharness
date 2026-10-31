import { ChatMessage } from '@buildaharness/runtime';
export interface CompactionResult {
    transcript: ChatMessage[];
    compacted: boolean;
}
/**
 * Collapses the oldest messages beyond the most recent `KEEP_RECENT` into one
 * synthetic summary message once the transcript crosses a message-count or
 * char-count threshold. Deliberately a truncated concatenation, not an LLM
 * summary — keeps compaction free instead of costing an extra call every time
 * a long session crosses the threshold.
 */
export declare const SUMMARY_HEADER = "[Earlier conversation summary]";
/** The messages compaction would drop for `transcript` right now (the older part), or null when it would not compact. M3's pre-compaction flush reads exactly these. Same threshold, no new trigger. */
export declare function messagesAboutToBeCompacted(transcript: ChatMessage[]): ChatMessage[] | null;
export declare function compactTranscript(transcript: ChatMessage[]): CompactionResult;
/**
 * Same thresholds and same messages kept as `compactTranscript`, but the older part is summarized by `summarize`
 * (semantic-compaction.ts) instead of truncated to 200 characters each. A `summarize` that returns null or throws
 * falls back to the truncated form, so this can never lose more than `compactTranscript` would have.
 */
export declare function compactTranscriptSemantic(transcript: ChatMessage[], summarize: (older: ChatMessage[]) => Promise<string | null>): Promise<CompactionResult>;
