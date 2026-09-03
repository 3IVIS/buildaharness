import {
  loadHarnessCheckpoint,
  deleteHarnessCheckpoint,
  type CheckpointStore,
  type LayerActivityEvent,
} from '@buildaharness/harness'
import { ANTHROPIC_DEFAULT_MODEL } from '@buildaharness/runtime'
import type { MemoryAdapter, ChatMessage, TokenUsage, FsBackend, MemoryResult } from '@buildaharness/runtime'
import { compactTranscript } from './transcript-compaction.js'
import {
  loadPendingAction,
  stagePendingAction,
  sweepAbandonedPendingActions,
  clearShellCache,
  type FileToolsContext,
} from './file-tools.js'
import {
  listUndoLogEntries as listUndoLogEntriesFromStore,
  loadUndoLogEntry,
  buildRevertPlan,
  type UndoLogEntry,
} from './action-snapshot.js'
import type { ShellToolsContext } from './shell-tools.js'
import type { ActionToolsContext } from './action-tools.js'
import { estimateCostUsd } from './model-pricing.js'
import { checkSpendCap, EMPTY_SPEND_STATE, type SpendCapConfig, type SpendState } from './spend-cap.js'

/** Same fallback model cli.ts's withCostEstimate uses when config.model is unset — both now import @buildaharness/runtime's ANTHROPIC_DEFAULT_MODEL rather than hand-syncing a literal. Only used to estimate cost for the spend cap when a turn's usage carries no real costUsd. */
const DEFAULT_MODEL_FOR_COST_ESTIMATE = ANTHROPIC_DEFAULT_MODEL

// A harness checkpoint left behind by a process that died mid-run is normally resumed
// transparently on the session's next turn. If resume() itself reliably fails for that
// particular checkpoint — e.g. the same crash it left behind repeats on replay — retrying it
// forever would wedge the session permanently instead of making progress. Persisted (see
// resumeAttemptsKey below) and incremented BEFORE each resume() attempt, not after, so a
// resume() call that crashes the whole process (never reaching harness-bridge.ts's normal
// cleanup) still counts toward the cap on the next launch — the scenario this exists for in the
// first place. Reset to 0 whenever resume() returns normally (paused or completed — either way,
// not a failure) or the checkpoint is cleared, manually (clearCheckpoint) or automatically (this
// cap). 2 rather than 1: a single failure is treated as possibly transient (e.g. a one-off tool
// error) before concluding the checkpoint itself is the problem.
export const RESUME_ATTEMPT_CAP = 2
export const resumeAttemptsKey = (sessionId: string): string => `resume-attempts:${sessionId}`

// Per-message search index, written alongside every transcript append (see
// appendTranscriptMessage) so a /search hit can resolve to the one exchange that matched instead
// of scoreEntries() having to score `transcript:<sessionId>`'s whole growing array as a single
// blob. Indexed by a persisted per-session counter, deliberately NOT by transcript.length at
// append time: transcript-compaction.ts can shrink the live transcript array (collapsing older
// messages into one synthetic summary), and deriving the index from the post-compaction array's
// length would silently collide a new message's index with an older, still-live index entry.
const messageIndexKey = (sessionId: string, messageIndex: number): string => `transcript-msg:${sessionId}:${messageIndex}`
const messageIndexCounterKey = (sessionId: string): string => `transcript-msg-count:${sessionId}`

// Bumped only if backfillMessageIndex's logic or IndexedMessage's shape changes in a way that
// requires re-running the backfill against installs that already completed an earlier version.
const MESSAGE_INDEX_BACKFILL_VERSION = 1
const MESSAGE_INDEX_BACKFILL_VERSION_KEY = 'message-index-backfill-version'

/**
 * One searchable, individually-addressable transcript entry — key `transcript-msg:<sessionId>:<n>`
 * (see messageIndexKey). Written alongside every `transcript:<sessionId>` append by
 * appendTranscriptMessage so scoreEntries() (via MemoryAdapter.search()) can resolve a hit to this
 * one exchange instead of the whole session array. Derived, not authoritative: the per-session
 * `transcript:<sessionId>` array remains the one source of truth for conversation replay,
 * compaction, and /export — losing an index entry (a failed write, or a pre-backfill install) only
 * ever degrades search recall, never conversation behavior.
 */
export interface IndexedMessage {
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  at: string
}

/** One ranked `/search` result — an `IndexedMessage` plus the graduated relevance score `scoreEntries()` gave it. */
export interface TranscriptSearchHit {
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  at: string
  score: number
}

// The Contradiction layer (harness-runtime.ts's reportLayer('contradiction', true, ...)) already
// phrases its reason as a direct, human-readable message ("Heads up — this seems to conflict with
// something you told me earlier: ...") — that message only ever reached the user if they happened
// to run /why, never the actual reply, even though the layer had already done the work of
// detecting a genuine identity/fact conflict a personal assistant tracking facts about its user
// should clearly flag proactively. Returned as its own field (not concatenated into `reply`)
// because `reply`'s text is often already on screen by the time this runs.
//
// The always-on lexical Contradiction layer (harness-runtime.ts's detectContradictions,
// packages/harness) has no id-stripping guard of its own — its raw description templates embed
// internal belief ids like "fact-respond-1-3" directly, and nothing between there and the user
// ever sanitizes them. The template itself lives in packages/harness, out of this package's
// scope, so this is a defense-in-depth backstop: recognize the specific raw-id-shaped token these
// templates produce and fall back to a generic but still-useful notice instead of ever showing
// leaked internals.
const RAW_BELIEF_ID_PATTERN = /\b(?:fact|belief)-[\w-]+-\d+(?:-\d+)?\b/

// Exported as its own constant (not just an inline literal in findContradictionNotice) so
// dedupedContradictionNotice can recognize this exact fallback and treat it specially — see its
// doc comment for why a content-free repeat of this one is suppressed once anything's already
// been shown, even though it isn't textually identical to a prior, more specific notice.
const GENERIC_CONTRADICTION_NOTICE = 'Heads up — this seems to conflict with something you told me earlier.'

function findContradictionNotice(layerActivity: LayerActivityEvent[]): string | undefined {
  const reason = layerActivity.find((e) => e.layer === 'contradiction' && e.fired)?.reason
  if (reason === undefined) return undefined
  return RAW_BELIEF_ID_PATTERN.test(reason) ? GENERIC_CONTRADICTION_NOTICE : reason
}

/**
 * Owns session/transcript/checkpoint/spend/undo bookkeeping — the "everyday persistence" half of
 * PersonalAssistant, split out in Phase 4d of the architecture remediation plan. `fileTools`/
 * `shellTools` are the same shared option objects AgentLoop also holds (needed here for the
 * shell-result-cache clear in clearSession, and the workspace lookup in undo/sweep) — not a
 * duplication, just two collaborators independently needing the same read-only context.
 */
export class AssistantSession {
  // The harness's WorldModel (and its own recordExternalContradiction dedup) is rebuilt empty
  // every turn, so an unresolved contradiction between two still-stored facts (e.g. two different
  // stated occupations) gets independently rediscovered and re-notified on every subsequent turn,
  // no matter how unrelated that turn's own message is. Keyed by sessionId (cleared in
  // clearSession, i.e. `/new`) and by the sorted statement texts involved (not belief ids, which
  // are reassigned each turn's fresh WorldModel).
  //
  // This in-process cache alone is not enough — every entry in it is lost on process restart
  // (crash or the ordinary `restart_before` scenario), even though the underlying persisted facts
  // that produced the original notice are untouched. Since the lexical Contradiction layer
  // rebuilds its WorldModel fresh from all persisted facts on every non-trivial turn, a stale,
  // already-acknowledged conflict from days/turns ago gets rediscovered and re-notified as if
  // brand new on the very first non-trivial turn after any restart.
  // getNotifiedContradictions/recordNotifiedContradiction below mirror this in-memory Map into
  // `this.memory` (the same durable store used for spend/transcript/fact state elsewhere) so the
  // dedup itself survives a restart; `/new` still clears it via clearSession, same as before.
  private readonly notifiedContradictions = new Map<string, Set<string>>()

  constructor(
    private readonly memory: MemoryAdapter,
    private readonly checkpointStore: CheckpointStore,
    private readonly spendCap: SpendCapConfig | undefined,
    private readonly model: () => string | undefined,
    private readonly fileTools: FileToolsContext | undefined,
    private readonly shellTools: ShellToolsContext | undefined,
    private readonly actionTools: ActionToolsContext | undefined,
  ) {}

  private static notifiedContradictionsKey(sessionId: string): string {
    return `notified-contradictions:${sessionId}`
  }

  async getNotifiedContradictions(sessionId: string): Promise<Set<string>> {
    const cached = this.notifiedContradictions.get(sessionId)
    if (cached) return cached
    const persisted = ((await this.memory.get(
      AssistantSession.notifiedContradictionsKey(sessionId),
    )) as string[] | undefined) ?? []
    const seen = new Set(persisted)
    this.notifiedContradictions.set(sessionId, seen)
    return seen
  }

  async recordNotifiedContradiction(sessionId: string, seen: Set<string>, value: string): Promise<void> {
    seen.add(value)
    await this.memory.set(AssistantSession.notifiedContradictionsKey(sessionId), [...seen])
  }

  /** findContradictionNotice's own text, deduped once per session — see notifiedContradictions'
   * doc comment and findContradictionNotice's for why this exists: without it, the always-on
   * lexical Contradiction layer re-fires the identical notice on every subsequent non-trivial
   * turn, since the WorldModel it runs against is rebuilt fresh (re-seeded from all known facts)
   * each turn with no memory of its own that this exact conflict was already surfaced. */
  async dedupedContradictionNotice(sessionId: string, layerActivity: LayerActivityEvent[]): Promise<string | undefined> {
    const notice = findContradictionNotice(layerActivity)
    if (!notice) return undefined
    const seen = await this.getNotifiedContradictions(sessionId)
    if (seen.has(notice)) return undefined
    // The generic fallback (used when the raw reason leaked belief ids — see
    // findContradictionNotice) carries no information beyond "something conflicts", so exact-text
    // dedup alone doesn't catch it — a different string, so `seen.has(notice)` above missed it.
    // Once the user has already seen ANY contradiction notice this session, a content-free repeat
    // of this one adds nothing, so it's suppressed rather than recorded/shown.
    if (notice === GENERIC_CONTRADICTION_NOTICE && seen.size > 0) return undefined
    await this.recordNotifiedContradiction(sessionId, seen, notice)
    return notice
  }

  /** Persisted alongside transcript/facts/plan (this.memory) — survives a process restart, same as everything else keyed by sessionId, so the ceiling is genuinely cross-session, not just cross-turn within one process lifetime. */
  async getSpendState(sessionId: string): Promise<SpendState> {
    return ((await this.memory.get(`spend:${sessionId}`)) as SpendState | undefined) ?? EMPTY_SPEND_STATE
  }

  /**
   * Pre-turn spend-cap check — a no-op (`{ allowed: true }`) whenever no cap is configured. Only
   * ever checked before a turn starts, never mid-turn (see spend-cap.ts's checkSpendCap doc
   * comment) — `turn()` skips this entirely for a pendingActionId continuation, since that's a
   * resumption of a turn that already passed this check when it first started.
   */
  async checkSpendCapForTurn(sessionId: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.spendCap) return { allowed: true }
    const spendState = await this.getSpendState(sessionId)
    return checkSpendCap(spendState, this.spendCap)
  }

  /**
   * Called once per successfully completed ('ok') turn — counts turns, not raw internal LLM
   * calls (see SpendCapConfig's doc comment for why). Estimates cost the same way cli.ts's
   * withCostEstimate does for a backend that doesn't report a real costUsd, so the cap enforces
   * against the same number /cost displays, not a second cost model.
   *
   * Always records, even when no cap is currently configured — the ledger must reflect true
   * cumulative spend regardless of whether a cap happens to exist yet, or a session that chats
   * for a while uncapped and only later runs `/config set sessionCostLimitUsd ...` would have
   * every turn before that point silently excluded from the cumulative total checkSpendCap
   * enforces against, understating real spend. The enforcement gate itself (checkSpendCapForTurn)
   * already correctly no-ops whenever no cap is configured, so this never enforces a cap that
   * isn't set.
   */
  async recordSpend(sessionId: string, usage: TokenUsage | undefined): Promise<void> {
    const state = await this.getSpendState(sessionId)
    const costUsd = usage?.costUsd ?? (usage ? estimateCostUsd(this.model() ?? DEFAULT_MODEL_FOR_COST_ESTIMATE, usage) : undefined) ?? 0
    await this.memory.set(`spend:${sessionId}`, {
      cumulativeCostUsd: state.cumulativeCostUsd + costUsd,
      cumulativeCalls: state.cumulativeCalls + 1,
      cumulativeInputTokens: state.cumulativeInputTokens + (usage?.inputTokens ?? 0),
      cumulativeOutputTokens: state.cumulativeOutputTokens + (usage?.outputTokens ?? 0),
    } satisfies SpendState)
  }

  /** The session's conversation transcript, oldest first — same array `turn()` reads/appends to. Used by `/export`. */
  async getTranscript(sessionId: string): Promise<ChatMessage[]> {
    return ((await this.memory.get(`transcript:${sessionId}`)) as ChatMessage[] | undefined) ?? []
  }

  /**
   * Reads `sessionId`'s transcript and runs it through transcript-compaction.ts's compactTranscript,
   * persisting the compacted array back when compaction actually collapsed anything — the first
   * thing `runTurn()` did with the raw transcript before this split. Kept on AssistantSession
   * (rather than the sequencer reading `memory` directly) so this remains the one place that reads
   * `transcript:${sessionId}` for a live turn.
   */
  async loadAndCompactTranscript(sessionId: string): Promise<ChatMessage[]> {
    const transcriptKey = `transcript:${sessionId}`
    const rawTranscript = ((await this.memory.get(transcriptKey)) as ChatMessage[] | undefined) ?? []
    const { transcript, compacted } = compactTranscript(rawTranscript)
    if (compacted) await this.memory.set(transcriptKey, transcript)
    return transcript
  }

  /**
   * Appends `message` to `transcriptKey`'s array — every site that used to call
   * `this.memory.set(transcriptKey, message, 'append')` directly now goes through here instead, so
   * a per-message search index entry (transcript-msg:<sessionId>:<n> — see messageIndexKey) is
   * always written alongside it, with no call site able to forget. The index write is best-effort:
   * caught and logged, never thrown — a search-indexing problem must never be able to break an
   * ordinary turn or lose the transcript message itself.
   */
  async appendTranscriptMessage(
    sessionId: string,
    transcriptKey: string,
    message: { role: 'user' | 'assistant'; content: string },
  ): Promise<void> {
    await this.memory.set(transcriptKey, message satisfies ChatMessage, 'append')
    try {
      const counterKey = messageIndexCounterKey(sessionId)
      const nextIndex = ((await this.memory.get(counterKey)) as number | undefined) ?? 0
      const indexed: IndexedMessage = { sessionId, role: message.role, content: message.content, at: new Date().toISOString() }
      await this.memory.set(messageIndexKey(sessionId, nextIndex), indexed)
      await this.memory.set(counterKey, nextIndex + 1)
    } catch (err) {
      console.error(`[message-index] failed to index a transcript message for session "${sessionId}":`, err)
    }
  }

  /**
   * One-off, idempotent backfill for installs that already had transcript history before the
   * message index existed: scans every `transcript:*` session currently in `this.memory` and
   * indexes whichever messages don't already have a `transcript-msg:` entry, so pre-existing
   * conversations become searchable too, not just messages sent after this shipped. Guarded by
   * MESSAGE_INDEX_BACKFILL_VERSION_KEY so it only does real work once per install (and once more
   * per future version bump); a second call is a cheap no-op. Only covers what's still present in
   * the live (possibly already-compacted) transcript array — a session already compacted before
   * backfill ran has already lost its older messages the same way /search would, a known,
   * documented limitation rather than a bug (see README).
   *
   * Run fire-and-forget from PersonalAssistant's constructor, never awaited by a turn — a large
   * pre-existing history must not delay the first prompt/render.
   */
  async backfillMessageIndex(): Promise<void> {
    try {
      if (await this.memory.get(MESSAGE_INDEX_BACKFILL_VERSION_KEY)) return
      const hits = await this.memory.search('', Number.MAX_SAFE_INTEGER, 0)
      for (const hit of hits) {
        if (typeof hit.key !== 'string' || !hit.key.startsWith('transcript:')) continue
        const sessionId = hit.key.slice('transcript:'.length)
        const transcript = hit.value as ChatMessage[] | undefined
        if (!Array.isArray(transcript) || transcript.length === 0) continue

        const counterKey = messageIndexCounterKey(sessionId)
        const alreadyIndexed = ((await this.memory.get(counterKey)) as number | undefined) ?? 0
        for (let i = alreadyIndexed; i < transcript.length; i++) {
          const message = transcript[i]
          if (message.role !== 'user' && message.role !== 'assistant') continue
          const indexed: IndexedMessage = { sessionId, role: message.role, content: message.content, at: new Date().toISOString() }
          await this.memory.set(messageIndexKey(sessionId, i), indexed)
        }
        await this.memory.set(counterKey, transcript.length)
      }
      await this.memory.set(MESSAGE_INDEX_BACKFILL_VERSION_KEY, MESSAGE_INDEX_BACKFILL_VERSION)
    } catch (err) {
      console.error('[message-index] backfill failed:', err)
    }
  }

  /**
   * Prunes stale `.pending-actions/` records on startup. A leftover record is harmless (never
   * applied without a matching id) but unbounded, so this keeps the directory from growing
   * forever across crashed/abandoned turns.
   *
   * Safety-first, not per-record: `stagePendingAction`'s records carry no `sessionId` (the id is a
   * random UUID, unrelated to any session — see file-tools.ts), so there is no direct way to tie
   * one staged record to one session's checkpoint. Rather than sweep blind, this skips the sweep
   * entirely for this startup if ANY known session still has a checkpoint eligible for resume —
   * the coarser, but always-safe, version of "never sweep a record that could still be
   * legitimately resumed". Known sessions are discovered the same way backfillMessageIndex
   * already does (transcript: key prefixes), so no new bookkeeping is added.
   */
  async sweepAbandonedPendingActionsOnStartup(): Promise<void> {
    try {
      const backend = this.fileTools?.backend ?? this.shellTools?.backend ?? this.actionTools?.backend
      const workspaceRoot = this.fileTools?.workspaceRoot ?? this.shellTools?.workspaceRoot ?? this.actionTools?.workspaceRoot
      if (!backend || !workspaceRoot) return

      const hits = await this.memory.search('', Number.MAX_SAFE_INTEGER, 0)
      for (const hit of hits) {
        if (typeof hit.key !== 'string' || !hit.key.startsWith('transcript:')) continue
        const sessionId = hit.key.slice('transcript:'.length)
        const checkpoint = await loadHarnessCheckpoint(this.checkpointStore, `turn:${sessionId}`)
        if (!checkpoint) continue
        const attempts = ((await this.memory.get(resumeAttemptsKey(sessionId))) as number | undefined) ?? 0
        if (attempts < RESUME_ATTEMPT_CAP) return // still resumable — skip the sweep entirely this startup
      }

      await sweepAbandonedPendingActions(backend, workspaceRoot)
    } catch (err) {
      console.error('[pending-actions] sweep failed:', err)
    }
  }

  /**
   * Records a message-level risk-gate decline (the `needs_approval` branch with no
   * `pendingActionId`) as a resolved, paired exchange, once the caller (cli.ts) knows the final
   * answer was "no". Unlike the eager-append this deliberately avoids inside runTurn itself (the
   * outcome isn't known yet at that point), this is safe: both the user message and a "declined"
   * reply are appended together, atomically, only after the decline is already final — there is
   * never a dangling, un-replied-to turn a later tool-enabled call could mistake for a live
   * request.
   *
   * Without this, a message-level decline (unlike a tool-call-level one, which resolvePendingAction
   * already persists) left zero trace at all: a later "did that unsubscribe actually happen?"
   * question found nothing in the transcript and confidently denied the request was ever made,
   * instead of correctly recalling that it was asked and declined.
   */
  async recordDeclinedRequest(sessionId: string, userMessage: string, reason: string): Promise<void> {
    const transcriptKey = `transcript:${sessionId}`
    await this.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.appendTranscriptMessage(sessionId, transcriptKey, {
      role: 'assistant',
      content: `(Declined — ${reason} No action was taken.)`,
    })
  }

  /**
   * Ends the current conversation: deletes the transcript, extracted facts, any active plan for
   * this session, and the shell-result cache (see file-tools.ts's shell-result-cache doc comment
   * — a fresh conversation shouldn't silently answer from a previous, unrelated conversation's
   * shell results), plus a leftover in-flight-turn checkpoint if one exists (from an abandoned
   * turn that never reached its normal cleanup). Deliberately leaves
   * `experienceStore`/`reminderStore`/DURABLE_FACTS_KEY untouched — those are durable,
   * cross-conversation learning, not per-conversation scratch state (see the README's "Three
   * things live outside a single harness run" section).
   */
  async clearSession(sessionId: string): Promise<void> {
    await this.memory.delete(`transcript:${sessionId}`)
    await this.memory.delete(`facts:${sessionId}`)
    await this.memory.delete(`plan:${sessionId}`)
    await deleteHarnessCheckpoint(this.checkpointStore, `turn:${sessionId}`)
    await this.memory.delete(resumeAttemptsKey(sessionId))
    this.notifiedContradictions.delete(sessionId)
    await this.memory.delete(AssistantSession.notifiedContradictionsKey(sessionId))
    const backend = this.fileTools?.backend ?? this.shellTools?.backend ?? this.actionTools?.backend
    const workspaceRoot = this.fileTools?.workspaceRoot ?? this.shellTools?.workspaceRoot ?? this.actionTools?.workspaceRoot
    if (backend && workspaceRoot) {
      await clearShellCache(backend, workspaceRoot)
    }
  }

  /**
   * Scoped recovery for a stuck harness checkpoint: clears just `turn:${sessionId}`'s checkpoint
   * (and its resume-attempt count) without touching transcript/facts/plan — unlike clearSession
   * (`/clear`/`/new`), which wipes the whole conversation. Returns `{ cleared: false }` when there
   * was nothing to clear, so a caller can report "nothing stuck" instead of a false "cleared".
   */
  async clearCheckpoint(sessionId: string): Promise<{ cleared: boolean; stepsUsed?: number; currentNode?: string }> {
    const runId = `turn:${sessionId}`
    const checkpoint = await loadHarnessCheckpoint(this.checkpointStore, runId)
    await this.memory.delete(resumeAttemptsKey(sessionId))
    if (!checkpoint) return { cleared: false }
    await deleteHarnessCheckpoint(this.checkpointStore, runId)
    return { cleared: true, stepsUsed: checkpoint.progress.stepsUsed, currentNode: checkpoint.progress.nodeExecutionOrder.at(-1) }
  }

  /**
   * Read-only counterpart to clearCheckpoint — reports whether `sessionId` has a checkpoint left
   * behind by a prior turn and how many times in a row it has already failed to resume, without
   * clearing anything. Lets a caller (cli.ts's `/checkpoint`) inspect before deciding whether to
   * clear.
   */
  async getCheckpointStatus(sessionId: string): Promise<{ present: boolean; stepsUsed?: number; currentNode?: string; failedResumeAttempts: number }> {
    const runId = `turn:${sessionId}`
    const checkpoint = await loadHarnessCheckpoint(this.checkpointStore, runId)
    const failedResumeAttempts = ((await this.memory.get(resumeAttemptsKey(sessionId))) as number | undefined) ?? 0
    return {
      present: checkpoint !== undefined,
      stepsUsed: checkpoint?.progress.stepsUsed,
      currentNode: checkpoint?.progress.nodeExecutionOrder.at(-1),
      failedResumeAttempts,
    }
  }

  /**
   * Removes the most recent exchange from conversation history — a completed turn drops its
   * user message and assistant reply (2 entries); a turn that ended in `needs_approval` before
   * any reply was appended drops just the pending user message (1 entry). Only affects what the
   * model remembers: a real `write_file`/`run_shell_command` effect from the undone turn is not
   * reversed. Returns `{ undone: false }` on an empty transcript instead of throwing.
   */
  async undoLastTurn(sessionId: string): Promise<{ undone: boolean }> {
    const transcriptKey = `transcript:${sessionId}`
    const transcript = ((await this.memory.get(transcriptKey)) as ChatMessage[] | undefined) ?? []
    if (transcript.length === 0) return { undone: false }

    const last = transcript[transcript.length - 1]
    const dropCount = last.role === 'assistant' ? 2 : 1
    await this.memory.set(transcriptKey, transcript.slice(0, Math.max(0, transcript.length - dropCount)))
    return { undone: true }
  }

  /** The workspace backend/root a staged write/shell/revert action lives under — `undefined` when neither fileTools nor shellTools is configured (e.g. a webTools-only assistant). Public: also used by ActionApprovalService for the same lookup. */
  undoWorkspace(): { backend: FsBackend; workspaceRoot: string } | undefined {
    const backend = this.fileTools?.backend ?? this.shellTools?.backend ?? this.actionTools?.backend
    const workspaceRoot = this.fileTools?.workspaceRoot ?? this.shellTools?.workspaceRoot ?? this.actionTools?.workspaceRoot
    return backend && workspaceRoot ? { backend, workspaceRoot } : undefined
  }

  /** Real filesystem effects still on record as revertible, newest first — bounded by action-snapshot.ts's UNDO_LOG_MAX_ENTRIES retention cap. Backs `/undo-action` with no argument. Distinct from `/undo` (undoLastTurn above), which only forgets conversation history — see README's /undo-action section for the naming distinction. */
  async listUndoLogEntries(): Promise<UndoLogEntry[]> {
    const workspace = this.undoWorkspace()
    if (!workspace) return []
    return listUndoLogEntriesFromStore(workspace.backend, workspace.workspaceRoot)
  }

  /**
   * Stages a revert of undo-log entry `id` as its own approval-gated `PendingActionPayload` —
   * reusing the exact same staging/approval machinery write_file/run_shell_command already use,
   * rather than a new confirmation concept. Approve/decline it the same way any other staged
   * action resolves: `turn('', { sessionId, approved, pendingActionId })`.
   */
  async stageUndoAction(id: string): Promise<{ status: 'staged'; pendingActionId: string; reason: string } | { status: 'error'; message: string }> {
    const workspace = this.undoWorkspace()
    if (!workspace) return { status: 'error', message: 'No workspace configured — file/shell tools are not enabled.' }
    const { backend, workspaceRoot } = workspace

    const entry = await loadUndoLogEntry(backend, workspaceRoot, id)
    if (!entry) return { status: 'error', message: `No undo-log entry with id "${id}".` }
    if (!entry.undoable) return { status: 'error', message: `Entry "${id}" cannot be reverted: ${entry.reason}` }

    const plan = buildRevertPlan(entry)
    if (!plan) return { status: 'error', message: `Entry "${id}" cannot be reverted.` }
    if (plan.restore.length === 0 && plan.remove.length === 0) {
      return { status: 'error', message: `Entry "${id}" made no filesystem changes to revert.` }
    }

    const { id: pendingActionId } = await stagePendingAction(backend, workspaceRoot, {
      kind: 'revert',
      revertedEntryId: id,
      restore: plan.restore,
      remove: plan.remove,
    })

    const parts: string[] = []
    if (plan.restore.length > 0) parts.push(`restore ${plan.restore.map((r) => `"${r.path}"`).join(', ')}`)
    if (plan.remove.length > 0) parts.push(`remove ${plan.remove.map((p) => `"${p}"`).join(', ')}`)
    const reason = `Reverting ${entry.kind === 'write' ? `write to "${entry.path}"` : `\`${entry.command}\``} — will ${parts.join(' and ')}.`

    return { status: 'staged', pendingActionId, reason }
  }

  /**
   * Ranked search over the per-message index (see appendTranscriptMessage/IndexedMessage), not
   * the whole session transcript — a hit resolves to the one exchange that matched. Deliberately
   * not scoped to a single sessionId: this is a single local install's memory namespace, and
   * "what did I tell you about my dentist appointment" should find it regardless of which
   * session it was said in.
   *
   * `MemoryAdapter.search()` scores every stored key in one pass (facts, reminders, experience
   * data, the message index itself, its counters, ...), so this asks for every entry scoring
   * above 0 rather than a small topK directly, then filters to `transcript-msg:` keys and
   * truncates afterward — otherwise a real match could be pushed out of a small topK by
   * unrelated non-transcript entries that happen to score higher. Read-only and synchronous over
   * already-persisted data: never an LLM call, never a network request, never a mutation. Used
   * by `/search`.
   *
   * `FileSystemAdapter.search()` (packages/runtime) throws if ANY file under the memory namespace
   * fails to parse as JSON — e.g. a transcript file left truncated by a process kill mid-write.
   * One corrupt entry unrelated to this query must not turn `/search` into an uncaught error for
   * the user — degrade to "no results" instead, same fail-open posture as the other two
   * `memory.search()` call sites (backfillMessageIndex, sweepAbandonedPendingActionsOnStartup).
   */
  async searchTranscript(query: string, topK = 10): Promise<TranscriptSearchHit[]> {
    if (!query.trim()) return []
    let candidates: MemoryResult[]
    try {
      candidates = await this.memory.search(query, Number.MAX_SAFE_INTEGER, 0)
    } catch (err) {
      console.error('[search] memory search failed:', err)
      return []
    }
    const hits: TranscriptSearchHit[] = []
    for (const c of candidates) {
      if (typeof c.key !== 'string' || !c.key.startsWith('transcript-msg:')) continue
      if (c.score <= 0) continue
      const value = c.value as IndexedMessage
      hits.push({ sessionId: value.sessionId, role: value.role, content: value.content, at: value.at, score: c.score })
    }
    return hits.slice(0, topK)
  }
}
