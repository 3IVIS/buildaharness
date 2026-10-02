import type { ToolEffectClass } from '@buildaharness/harness'

/**
 * AL5a: each tool's effect class — a non-linguistic source for which tools a turn may use to
 * change the world. Feeds `deriveConsequentialTools` (write / execute are consequential; `network`
 * here is outbound read-only egress and is not). Keep in step with the tool definitions in
 * file-tools.ts, web-tools.ts, shell-tools.ts, reminder-tools.ts and action-tools.ts; a tool
 * missing here is treated as consequential by `deriveConsequentialTools`.
 */
export const TOOL_EFFECT_CLASS: Record<string, ToolEffectClass> = {
  read_file: 'read',
  list_directory: 'read',
  list_reminders: 'read',
  recall_memory: 'read',
  web_search: 'network',
  fetch_url: 'network',
  write_file: 'write',
  create_reminder: 'write',
  send_email: 'write',
  run_shell_command: 'execute',
}
