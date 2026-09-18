/**
 * A real, non-mutating tool call the model made while producing a reply — grounds a reply in something other
 * than the model's own words. write_file is deliberately excluded: until approved, nothing was actually read or
 * changed. `path` holds the file path for read_file/list_directory, the URL for fetch_url, or the query for
 * web_search — same shape, different meaning per tool, to keep this interface minimal.
 *
 * Split into its own file (rather than living on assistant.ts or agent-loop.ts) so both can import it without
 * either owning it — AgentLoop produces AssistantSource entries while executing tool calls, and assistant.ts's
 * public AssistantTurnResult.sources field is typed with it.
 */
export interface AssistantSource {
  tool: 'read_file' | 'list_directory' | 'web_search' | 'fetch_url'
  path: string
}
