/**
 * Full conversation content, for a caller that wants live visibility while debugging — a
 * user's message, the assistant's final reply/reason, or one real tool call's name/input/
 * result. Not privacy-scrubbed and not truncated to name-only the way TraceEvent is; a
 * caller opts into this explicitly (see PersonalAssistantOptions.onDebugLog) knowing it
 * carries real content, not just metadata.
 *
 * `approval_request` is a state-changing action (write/shell/email) staged for the user's yes/no, and
 * `approval_decision` is how that was resolved ('approved' or 'declined'); the executed result of an
 * approved action is the separate `tool_call` entry, so a log reader can reconstruct the whole exchange.
 *
 * Split into its own file so both assistant.ts (user_message/assistant_reply kinds, emitted from
 * `turn()`) and agent-loop.ts (tool_call kind, emitted from the ReAct loop) can depend on it
 * without either owning the other.
 */
export interface DebugLogEntry {
  kind: 'user_message' | 'assistant_reply' | 'tool_call' | 'approval_request' | 'approval_decision'
  sessionId: string
  content: string
}
