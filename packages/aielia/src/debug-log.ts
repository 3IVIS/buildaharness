/**
 * Full conversation content, for a caller that wants live visibility while debugging — a
 * user's message, the assistant's final reply/reason, or one real tool call's name/input/
 * result. Not privacy-scrubbed and not truncated to name-only the way TraceEvent is; a
 * caller opts into this explicitly (see PersonalAssistantOptions.onDebugLog) knowing it
 * carries real content, not just metadata.
 *
 * Split into its own file so both assistant.ts (user_message/assistant_reply kinds, emitted from
 * `turn()`) and agent-loop.ts (tool_call kind, emitted from the ReAct loop) can depend on it
 * without either owning the other.
 */
export interface DebugLogEntry {
  kind: 'user_message' | 'assistant_reply' | 'tool_call'
  sessionId: string
  content: string
}
