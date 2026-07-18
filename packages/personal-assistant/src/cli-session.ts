import type { ChatMessage, TokenUsage } from '@buildaharness/runtime'
import type { AssistantConfig } from './config.js'
import { formatConfigListing } from './cli-config.js'
import type { MemorySummary, MemoryExport, TranscriptSearchHit } from './assistant.js'
import type { UndoLogEntry } from './action-snapshot.js'

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
  { command: '/undo', description: 'Remove the last exchange from conversation history — never reverses a real write_file/run_shell_command effect (see /undo-action)' },
  { command: '/undo-action [id]', description: 'List revertible filesystem effects from approved actions, or stage a revert of one for approval' },
  { command: '/memory', description: 'Show learned facts, reminders, and experience-store content' },
  { command: '/memory export [file]', description: 'Save the full, unbounded learned-experience contents (plus facts/reminders) to a JSON file' },
  { command: '/search <query>', description: 'Search past messages by content — ranked, not just exact-match' },
  { command: '/model [name]', description: 'Show or switch the active model' },
  { command: '/cost', description: 'Show token usage for the last turn and this session' },
  { command: '/doctor', description: 'Check proxy/claude-cli/workspace/data-dir health' },
  { command: '/why', description: 'Explain the harness path the last turn took' },
  { command: '/layers', description: 'Show all 11 harness layers — fired/skipped and why, for the last turn' },
  { command: '/sources', description: 'List files/URLs the last turn actually consulted' },
  { command: '/plan', description: "Show the active structured plan's task status" },
  { command: '/config ...', description: 'View or change persisted settings' },
  { command: '/checkpoint [clear]', description: 'Inspect, or clear, a stuck in-progress harness checkpoint' },
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
  /** Real filesystem effects still on record as revertible (see action-snapshot.ts) — omitted entirely when no workspace is configured (fileTools/shellTools both absent), same "don't imply a capability that isn't there" rule the banner's capability list already follows. */
  undoLogEntries?: UndoLogEntry[]
  /** Pre-formatted by spend-cap.ts's formatSpendCapStatus — undefined when no ceiling is configured, in which case the line is omitted entirely. */
  spendCapLine?: string
}

/** Reuses formatConfigListing for the config half rather than re-formatting the same fields a second way. */
export function formatStatus(info: StatusInfo): string {
  const lines = [
    formatConfigListing(info.config, info.overriddenKeys),
    '',
    `  ${'transcript'.padEnd(14)} ${info.transcriptLength} message${info.transcriptLength === 1 ? '' : 's'} this session`,
    `  ${'active plan'.padEnd(14)} ${info.planActive ? 'yes (see /plan)' : 'none'}`,
  ]
  if (info.undoLogEntries !== undefined) {
    const total = info.undoLogEntries.length
    const undoable = info.undoLogEntries.filter((e) => e.undoable).length
    lines.push(
      `  ${'undo-log'.padEnd(14)} ${total} entr${total === 1 ? 'y' : 'ies'} (${undoable} revertible) — see /undo-action`,
    )
  }
  if (info.spendCapLine) {
    lines.push(`  ${'spend cap'.padEnd(14)} ${info.spendCapLine}`)
  }
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

  const strategyWeightEntries = Object.entries(summary.experience.strategyWeights)
  sections.push('\nStrategy weights:')
  sections.push(
    strategyWeightEntries.length > 0
      ? strategyWeightEntries.map(([key, weight]) => `  - ${key}: ${weight.toFixed(3)}`).join('\n')
      : '  None yet',
  )

  sections.push('\nLearned decompositions (most recent, up to 20):')
  sections.push(
    summary.experience.decompositions.length > 0
      ? summary.experience.decompositions
          .map((d) => `  - ${d.task_type}: ${d.decomposition.join(' → ')} (${(d.success_rate * 100).toFixed(0)}% success)`)
          .join('\n')
      : '  None yet',
  )

  sections.push('\nRecovery sequences (most recent, up to 20):')
  sections.push(
    summary.experience.recoverySequences.length > 0
      ? summary.experience.recoverySequences
          .map((r) => `  - ${r.failure_class}: ${r.strategy_sequence.join(' → ')} (${(r.success_rate * 100).toFixed(0)}% success)`)
          .join('\n')
      : '  None yet',
  )

  return sections.join('\n')
}

/** Renders `/memory export`'s full, unbounded contents as pretty-printed JSON — a plain formatting function so it's unit-testable the same way as every other cli-session.ts formatter; cli.ts does the actual file write. */
export function formatMemoryExport(data: MemoryExport): string {
  return JSON.stringify(data, null, 2)
}

/** Truncates `content` to a snippet around the first matching term when possible, else the leading `maxLen` chars — full messages can be long, and a search result list is meant to be scannable, not a second transcript view. */
function snippet(content: string, query: string, maxLen = 160): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLen) return normalized
  const firstTerm = query.split(/\s+/).find((t) => t.length > 0)
  const matchAt = firstTerm ? normalized.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1
  if (matchAt === -1) return `${normalized.slice(0, maxLen)}…`
  const start = Math.max(0, matchAt - maxLen / 2)
  const end = Math.min(normalized.length, start + maxLen)
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`
}

/** Renders `/search <query>`'s results — each hit is one message (session id short form, timestamp, role, snippet), ranked by relevance, never the whole session it came from. An empty list is an explicit "no results" line, never a silent blank output. */
export function formatSearchResults(hits: TranscriptSearchHit[], query: string): string {
  if (hits.length === 0) return `No results for "${query}".`
  return hits
    .map((h) => {
      const shortSession = h.sessionId.length > 8 ? `${h.sessionId.slice(0, 8)}…` : h.sessionId
      return `  [${shortSession}] ${h.at}  ${h.role.padEnd(9)} ${snippet(h.content, query)}`
    })
    .join('\n')
}

function undoLogEntryLabel(entry: UndoLogEntry): string {
  return entry.kind === 'write' ? `write "${entry.path}"` : `shell \`${entry.command}\``
}

/** Renders /undo-action's no-argument listing — newest first (see action-snapshot.ts's listUndoLogEntries), with each entry's undoable status so the user doesn't have to stage a revert just to find out it's unavailable. */
export function formatUndoLogListing(entries: UndoLogEntry[]): string {
  if (entries.length === 0) return 'No undo-log entries yet — nothing to revert.'
  return entries
    .map((e) => {
      const status = e.undoable ? 'undoable' : `NOT undoable — ${e.reason}`
      return `  ${e.id}  ${undoLogEntryLabel(e)}  (${e.appliedAt})  [${status}]`
    })
    .join('\n')
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

/** Default /memory export filename when none is given — same sanitized-ISO-timestamp convention as defaultExportFilename, JSON instead of markdown. */
export function defaultMemoryExportFilename(now: Date = new Date()): string {
  return `assistant-memory-${now.toISOString().replace(/[:.]/g, '-')}.json`
}

export interface CostSummaryInfo {
  /** Usage for the turn just completed — absent when the last turn reported no usage at all, or no turn has completed yet. */
  lastTurn?: TokenUsage
  /** Running total across the session — {inputTokens: 0, outputTokens: 0} before any usage has ever been reported. */
  session: TokenUsage
  backend: 'proxy' | 'claude-cli' | 'anthropic' | 'openai' | 'openrouter'
  /** Pre-formatted by spend-cap.ts's formatSpendCapStatus — undefined when no ceiling is configured, in which case the line is omitted entirely (same convention as StatusInfo.spendCapLine). */
  spendCapLine?: string
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
  if (info.spendCapLine) lines.push(`Session ceiling: ${info.spendCapLine}`)
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
