import { NextStepSuggestion } from './next-step-proposer.js';
import { ChatMessage, TokenUsage } from '@buildaharness/runtime';
import { AssistantConfig } from './config.js';
import { MemorySummary, MemoryExport, TranscriptSearchHit, MemoryPendingOutcome } from './assistant.js';
import { AuditEntry, MemoryStatus, MemoryInjection } from './memory-service.js';
import { GoalGraphState } from './goal-graph-service.js';
import { UndoLogEntry } from './action-snapshot.js';
import { UserFact } from './fact-extraction.js';
/**
 * Text that came from the model, a tool result, a file or a web page must not reach the terminal raw: an
 * embedded escape sequence can clear the screen, rewrite earlier lines (hiding what an approval prompt is
 * really asking), set the window title or write the clipboard (OSC 52). Newlines and tabs survive; everything
 * that could drive the terminal is removed. Plain text is returned unchanged.
 */
export declare function stripTerminalControls(text: string): string;
export interface CliCommandHelp {
    command: string;
    description: string;
}
/** A bare `exit` / `quit` (with or without a leading slash, any case) ends the session; anything longer is an ordinary message. An exact command match, not a reading of the message. */
export declare function isQuitCommand(message: string): boolean;
/** Projected from COMMAND_REGISTRY (commands.ts), in registry order — add a command there, not here. */
export declare const CLI_COMMANDS_HELP: CliCommandHelp[];
export declare function formatHelp(): string;
export interface StatusInfo {
    config: AssistantConfig;
    overriddenKeys: ReadonlySet<keyof AssistantConfig>;
    transcriptLength: number;
    planActive: boolean;
    /** Real filesystem effects still on record as revertible (see action-snapshot.ts) — omitted entirely when no workspace is configured (fileTools/shellTools both absent), same "don't imply a capability that isn't there" rule the banner's capability list already follows. */
    undoLogEntries?: UndoLogEntry[];
    /** Pre-formatted by spend-cap.ts's formatSpendCapStatus — undefined when no ceiling is configured, in which case the line is omitted entirely. */
    spendCapLine?: string;
}
/** Reuses formatConfigListing for the config half rather than re-formatting the same fields a second way. */
export declare function formatStatus(info: StatusInfo): string;
/** Renders the result of `/memory confirm`/`/memory reject` — cli.ts's handleMemoryConfirm/handleMemoryReject print this directly. */
export declare function formatMemoryPendingOutcome(action: 'confirmed' | 'rejected' | 'forgotten', outcome: MemoryPendingOutcome): string;
export declare function formatMemorySummary(summary: MemorySummary): string;
/** `/memory history` — one line per audit entry. */
export declare function formatMemoryHistory(entries: AuditEntry[]): string;
/** `/memory archive` — facts a newer keyed statement replaced. */
export declare function formatMemoryArchive(facts: UserFact[], restorableCount?: number): string;
/** The "Why?" / `/why` line: which stored facts the last reply could have known, and how many were left out. Says "in the prompt", not "used". */
export declare function formatMemoryInjection(injection: MemoryInjection | undefined): string;
/** `/memory status` and the memory panel header. */
export declare function formatMemoryStatus(status: MemoryStatus): string;
/** `/doctor` entries for memory (CLI via doctor-checks.ts, chat-ui directly — same pure function on both surfaces). */
export declare function memoryStatusChecks(status: MemoryStatus): DoctorCheck[];
/** Renders `/memory export`'s full, unbounded contents as pretty-printed JSON — a plain formatting function so it's unit-testable the same way as every other cli-session.ts formatter; cli.ts does the actual file write. */
export declare function formatMemoryExport(data: MemoryExport): string;
/** Renders `/search <query>`'s results — each hit is one message (session id short form, timestamp, role, snippet), ranked by relevance, never the whole session it came from. An empty list is an explicit "no results" line, never a silent blank output. */
export declare function formatSearchResults(hits: TranscriptSearchHit[], query: string): string;
/** Renders the turn-end next-step options shown under a full turn's reply — numbered so the CLI can accept a bare `1`/`2`/`3` as "run that one" (see cli.ts's dispatchOne). Only the description is shown; the rationale and confidence stay in the structured result for richer front ends. */
export declare function formatNextSteps(steps: NextStepSuggestion[]): string;
/**
 * Renders `/goals`' review surface (R5, "Visibility") — every known GoalThread this session, each
 * tagged with which of R5's four visibility buckets it falls in
 * (freshly-computed/carried-over/done/suggested-but-not-committed), so a user can tell live state
 * apart from stale carryover without re-deriving it from raw JSON. An empty graph is an explicit
 * line, same convention `formatSearchResults` follows for zero hits.
 */
export declare function formatGoalGraphState(state: GoalGraphState): string;
/** Renders /undo-action's no-argument listing — newest first (see action-snapshot.ts's listUndoLogEntries), with each entry's undoable status so the user doesn't have to stage a revert just to find out it's unavailable. */
export declare function formatUndoLogListing(entries: UndoLogEntry[]): string;
/** Renders a transcript as markdown for /export — "You:"/"Assistant:" turns, oldest first. */
export declare function formatTranscriptMarkdown(transcript: ChatMessage[]): string;
/** Default /export filename when none is given — mirrors Claude Code's own /export default-name convention. Colons/dots are filesystem-unsafe on some platforms, so the ISO timestamp is sanitized. */
export declare function defaultExportFilename(now?: Date): string;
/** Default /memory export filename when none is given — same sanitized-ISO-timestamp convention as defaultExportFilename, JSON instead of markdown. */
export declare function defaultMemoryExportFilename(now?: Date): string;
export interface CostSummaryInfo {
    /** Usage for the turn just completed — absent when the last turn reported no usage at all, or no turn has completed yet. */
    lastTurn?: TokenUsage;
    /** Running total across the session — {inputTokens: 0, outputTokens: 0} before any usage has ever been reported. */
    session: TokenUsage;
    backend: 'proxy' | 'claude-cli' | 'anthropic' | 'openai' | 'openrouter';
    /** Pre-formatted by spend-cap.ts's formatSpendCapStatus — undefined when no ceiling is configured, in which case the line is omitted entirely (same convention as StatusInfo.spendCapLine). */
    spendCapLine?: string;
}
/** Renders /cost's output. The backend-specific footnote matters: claude-cli's cost is real (but may read $0 on a Pro/Max subscription, not API billing) and openrouter's is as reported by OpenRouter; every other backend's cost, when shown, is a static-table estimate (see turn-cost.ts's withCostEstimate), never real billing data — see model-pricing.ts. */
export declare function formatCostSummary(info: CostSummaryInfo): string;
export interface DoctorCheck {
    label: string;
    ok: boolean;
    /** Failure reason ("timed out", "not found", an HTTP status, etc.) — omitted entirely on a passing check. */
    detail?: string;
}
/** Renders /doctor's ✓/✗ list — the actual checks (network fetch, subprocess spawn, filesystem stat) run in cli.ts, which has the I/O; this just formats the results. */
export declare function formatDoctorReport(checks: DoctorCheck[]): string;
