/**
 * Central glyph-to-meaning vocabulary for status marks printed by the CLI/TUI. Added because the
 * live terminal comparison (`reports/cli_appearance_comparison_2026-09-17.md`) found `⚙` used for
 * two unrelated meanings at once — `writeToolStep` (cli.ts) prefixed *every* tool-call step with
 * it, so "Proposing to run: rm -rf /tmp/x" (about to ask for approval) and "Fetching
 * https://…" (a routine, no-approval-needed read) were visually indistinguishable at a glance,
 * unlike Codex's distinct glyph-per-state convention. The status-mark glyphs already used
 * elsewhere in cli.ts (`✓`/`✗`/`○`/`▶`/`~` for plan tasks, layer-fired marks, batch outcomes) were
 * already each used for one consistent meaning — only the tool-step glyph needed splitting.
 */
export const ICONS = {
  /** A routine, no-approval-needed tool step (read_file, fetch_url, web_search, list_reminders, …). */
  toolStep: '⚙',
  /** A tool step that is itself the proposal of a state-changing action (write_file, run_shell_command) — printed on the same in-flight step line, before the separate "[needs approval — …]" prompt appears. */
  proposalStep: '⚠',
  /** A read-only tool call `tool-policy.ts` denied before it executed — deliberately not `✗` (cli.ts already uses that, unprefixed, as the leading character of several unrelated config/undo-action error lines; reusing it here would misclassify those as `'tool'`-kind in tui-app.tsx's `TOOL_STEP_PREFIXES` match). */
  deniedStep: '⛔',
} as const

/**
 * Marker `cli.ts`'s `printPlan()` prepends to its combined plan-status block (Phase 6, "distinct
 * plan-mode UI") so `tui-app.tsx`'s `classifyLineKind` renders it as a dedicated `PlanBox` instead
 * of plain `'system'` text — lives here rather than in `tui-app.tsx` itself so `cli.ts` (which
 * `tui-app.tsx` already imports) doesn't need a reverse import back to it, the same reason the
 * tool-step glyphs above live here instead of in either of those two files.
 */
export const PLAN_LINE_PREFIX = '▤PLAN▤'

/** Tool names whose step line should use {@link ICONS.proposalStep} instead of {@link ICONS.toolStep} — the same two tools `risk-classifier.ts` treats as state-changing/approval-gated. */
const PROPOSAL_TOOLS = new Set(['write_file', 'run_shell_command'])

/** Picks the right glyph for one `AssistantToolStep`'s in-flight summary line — shared so `cli.ts` and any other surface printing a tool-step line stay in sync with the same mapping. */
export function toolStepIcon(tool: string): string {
  return PROPOSAL_TOOLS.has(tool) ? ICONS.proposalStep : ICONS.toolStep
}
