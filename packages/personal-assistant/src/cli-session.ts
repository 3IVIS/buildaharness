import type { ChatMessage, TokenUsage } from '@buildaharness/runtime'
import type { AssistantConfig } from './config.js'
import { formatConfigListing } from './cli-config.js'
import type { MemorySummary } from './assistant.js'

/**
 * Pure formatting/logic backing cli.ts's session-level commands (/help, /status, /export,
 * /memory, /cost, /doctor) — split out so it's unit-testable without a real readline loop,
 * the same way cli-config.ts already is for the /config family. cli.ts stays thin glue
 * (reading live state, calling these, doing actual file I/O) on top of these functions.
 */

export interface CliCommandHelp {
  command: string
  description: string
}

/** Kept as a hand-maintained list rather than derived from cli.ts's dispatch table — see /help's task note on why this can drift and needs manual upkeep when a command is added. */
export const CLI_COMMANDS_HELP: CliCommandHelp[] = [
  { command: '/help', description: 'Show this list' },
  { command: '/clear (/new)', description: 'Start a fresh conversation' },
  { command: '/status', description: 'Show current model, backend, workspace, and enabled capabilities' },
  { command: '/export [file]', description: "Save this session's transcript to a markdown file" },
  { command: '/undo', description: 'Remove the last exchange from conversation history' },
  { command: '/memory', description: 'Show learned facts, reminders, and experience-store counts' },
  { command: '/model [name]', description: 'Show or switch the active model' },
  { command: '/cost', description: 'Show token usage for the last turn and this session' },
  { command: '/doctor', description: 'Check proxy/claude-cli/workspace/data-dir health' },
  { command: '/why', description: 'Explain the harness path the last turn took' },
  { command: '/sources', description: 'List files/URLs the last turn actually consulted' },
  { command: '/plan', description: "Show the active structured plan's task status" },
  { command: '/config ...', description: 'View or change persisted settings' },
]

export function formatHelp(): string {
  const width = Math.max(...CLI_COMMANDS_HELP.map((c) => c.command.length))
  return CLI_COMMANDS_HELP.map((c) => `  ${c.command.padEnd(width + 2)} ${c.description}`).join('\n')
}

export interface StatusInfo {
  config: AssistantConfig
  overriddenKeys: ReadonlySet<keyof AssistantConfig>
  transcriptLength: number
  planActive: boolean
}

/** Reuses formatConfigListing for the config half rather than re-formatting the same fields a second way. */
export function formatStatus(info: StatusInfo): string {
  const lines = [
    formatConfigListing(info.config, info.overriddenKeys),
    '',
    `  ${'transcript'.padEnd(14)} ${info.transcriptLength} message${info.transcriptLength === 1 ? '' : 's'} this session`,
    `  ${'active plan'.padEnd(14)} ${info.planActive ? 'yes (see /plan)' : 'none'}`,
  ]
  return lines.join('\n')
}

export function formatMemorySummary(summary: MemorySummary): string {
  const sections: string[] = []

  sections.push('Facts I know:')
  sections.push(summary.facts.length > 0 ? summary.facts.map((f) => `  - ${f.text}`).join('\n') : '  None yet')

  sections.push('\nReminders:')
  sections.push(
    summary.reminders.length > 0
      ? summary.reminders.map((r) => `  - ${r.rawText}${r.done ? ' (done)' : ''}`).join('\n')
      : '  None yet',
  )

  sections.push('\nLearned from experience:')
  sections.push(`  ${summary.experience.strategyWeightCount} strategy weight(s)`)
  sections.push(`  ${summary.experience.decompositionCount} learned decomposition(s)`)
  sections.push(`  ${summary.experience.recoverySequenceCount} recovery sequence(s)`)

  return sections.join('\n')
}

/** Renders a transcript as markdown for /export — "You:"/"Assistant:" turns, oldest first. */
export function formatTranscriptMarkdown(transcript: ChatMessage[]): string {
  return transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `**${m.role === 'user' ? 'You' : 'Assistant'}:** ${m.content}`)
    .join('\n\n')
}

/** Default /export filename when none is given — mirrors Claude Code's own /export default-name convention. Colons/dots are filesystem-unsafe on some platforms, so the ISO timestamp is sanitized. */
export function defaultExportFilename(now: Date = new Date()): string {
  return `assistant-transcript-${now.toISOString().replace(/[:.]/g, '-')}.md`
}

export interface CostSummaryInfo {
  /** Usage for the turn just completed — absent when the last turn reported no usage at all, or no turn has completed yet. */
  lastTurn?: TokenUsage
  /** Running total across the session — {inputTokens: 0, outputTokens: 0} before any usage has ever been reported. */
  session: TokenUsage
  backend: 'proxy' | 'claude-cli' | 'anthropic' | 'openai' | 'openrouter'
}

function formatUsageLine(usage: TokenUsage): string {
  const tokens = `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`
  return usage.costUsd !== undefined ? `${tokens}  (~$${usage.costUsd.toFixed(4)})` : tokens
}

/** Renders /cost's output. The backend-specific footnote matters: claude-cli's cost is real (but may read $0 on a Pro/Max subscription, not API billing); every other backend's cost, when shown, is a static-table estimate (see cli.ts's withCostEstimate), never real billing data — see model-pricing.ts. */
export function formatCostSummary(info: CostSummaryInfo): string {
  if (!info.lastTurn && info.session.inputTokens === 0 && info.session.outputTokens === 0) {
    return 'No usage yet this session.'
  }
  const lines: string[] = []
  if (info.lastTurn) lines.push(`Last turn:    ${formatUsageLine(info.lastTurn)}`)
  lines.push(`This session: ${formatUsageLine(info.session)}`)
  if (info.backend === 'claude-cli') {
    lines.push('(cost is real usage from your Claude Code session — may read $0 on a Pro/Max subscription rather than API billing)')
  } else if (info.session.costUsd !== undefined) {
    lines.push('(cost is an approximate estimate from a static pricing table, not real billing data)')
  }
  return lines.join('\n')
}

export interface DoctorCheck {
  label: string
  ok: boolean
  /** Failure reason ("timed out", "not found", an HTTP status, etc.) — omitted entirely on a passing check. */
  detail?: string
}

/** Renders /doctor's ✓/✗ list — the actual checks (network fetch, subprocess spawn, filesystem stat) run in cli.ts, which has the I/O; this just formats the results. */
export function formatDoctorReport(checks: DoctorCheck[]): string {
  return checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.label}${!c.ok && c.detail ? ` — ${c.detail}` : ''}`).join('\n')
}
