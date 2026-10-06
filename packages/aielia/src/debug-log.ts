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
 * `next_steps` is the numbered list of suggestions printed under a reply (one entry per turn that produced any).
 *
 * `note` records a robustness action the loop took on its own (an empty final answer retried, or replaced by a
 * deterministic fallback), so a log reader can see why a reply is not what the model first returned.
 *
 * Split into its own file so both assistant.ts (user_message/assistant_reply kinds, emitted from
 * `turn()`) and agent-loop.ts (tool_call kind, emitted from the ReAct loop) can depend on it
 * without either owning the other.
 */
export interface DebugLogEntry {
  kind: 'user_message' | 'user_message_queued' | 'assistant_reply' | 'tool_call' | 'approval_request' | 'approval_decision' | 'note' | 'next_steps'
  sessionId: string
  content: string
}
