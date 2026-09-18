import type { ToolStepEvent } from '@buildaharness/runtime'

/**
 * Live, UI-facing tool-call event — deliberately distinct from trace-events.ts's TraceEvent
 * (`kind: 'tool_call'`), which is intentionally name/status-only telemetry safe to hand to
 * an arbitrary logging sink. This one exists purely so a front end can show "what is the
 * assistant doing right now" the way Claude Code's own CLI does, so it carries a
 * human-readable summary and the raw input.
 */
export interface AssistantToolStep extends ToolStepEvent {
  summary: string
  /**
   * Set only on a second, follow-up `onToolStep` call fired immediately after `tool-policy.ts`'s
   * `evaluateToolPolicy()` denies this exact call (see `agent-loop.ts`'s `checkToolPolicy`) — the
   * first call (this field absent) already reported the proposal itself. Without this, a denied
   * read-only tool call was invisible to the user: the model saw a "Denied by tool policy: …"
   * result, but nothing ever told the person watching the transcript that the call didn't happen
   * (report finding: "no confirmation, no denial message, nothing to distinguish 'the policy
   * allowed this' from 'there was no policy at all'").
   */
  deniedReason?: string
}

/**
 * Strips an MCP-qualified tool name (`mcp__<server>__<tool>`, how Claude Code CLI surfaces
 * a tool registered via --mcp-config) down to the bare name our own tool defs use — a
 * plain API/proxy backend's tool names never have this prefix, so this is a no-op there.
 */
export function stripMcpToolPrefix(name: string): string {
  const match = /^mcp__.+?__(.+)$/.exec(name)
  return match ? match[1] : name
}

/**
 * One human-readable line per tool call, shared across every front end (CLI/chat-ui/desktop)
 * and every backend (the proxy's own tool loop in assistant.ts, ClaudeCliLLMClient's stream
 * parsing) so "what step is this" reads identically no matter where it's rendered.
 */
export function summarizeToolStep(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
      return `Reading ${input.path ?? '?'}`
    case 'list_directory':
      return `Listing ${input.path ?? '.'}`
    case 'write_file':
      return `Proposing a write to ${input.path ?? '?'}`
    case 'run_shell_command':
      return `Proposing to run: ${input.command ?? '?'}`
    case 'web_search':
      return `Searching the web for "${input.query ?? '?'}"`
    case 'fetch_url':
      return `Fetching ${input.url ?? '?'}`
    case 'create_reminder':
      return 'Creating a reminder'
    case 'list_reminders':
      return 'Listing reminders'
    default:
      return `Calling ${tool}`
  }
}
