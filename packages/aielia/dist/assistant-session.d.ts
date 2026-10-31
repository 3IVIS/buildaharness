import { CheckpointStore, LayerActivityEvent, ExternalContradictionInput } from '@buildaharness/harness';
import { MemoryAdapter, ChatMessage, TokenUsage, FsBackend } from '@buildaharness/runtime';
import { FileToolsContext } from './file-tools.js';
import { UndoLogEntry } from './action-snapshot.js';
import { ShellToolsContext } from './shell-tools.js';
import { ActionToolsContext } from './action-tools.js';
import { SpendCapConfig, SpendState } from './spend-cap.js';
/**
 * P1 of the internal plan — session/turn-routing switch, distinct from a
 * tool-permission list. While `active`, `assistant.ts`'s turn entry point routes every incoming
 * message for this session to `PlanDraftingService` instead of `TurnInterpreter`'s normal
 * classify/tool-loop pipeline (see PlanDraftingService's own doc comment for the two designed
 * exits). `draftId` is an opaque per-entry token (not a lookup key into anything today — the
 * drafting `PlanRecord` itself still lives at plan-store.ts's single `plan:${sessionId}` slot,
 * same as an ordinary plan) reserved for P2's approval flow to correlate "the draft that was
 * staged" against "the draft the user is approving", the same "resolved by exactly what was
 * staged, never re-derived" discipline ActionApprovalService/AskClarificationService already
 * follow.
 */
export interface PlanModeState {
    active: boolean;
    draftId: string;
}
export declare const RESUME_ATTEMPT_CAP = 2;
export declare const resumeAttemptsKey: (sessionId: string) => string;
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
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    at: string;
}
/** One ranked `/search` result — an `IndexedMessage` plus the graduated relevance score `scoreEntries()` gave it. */
export interface TranscriptSearchHit {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    at: string;
    score: number;
}
/**
 * Owns session/transcript/checkpoint/spend/undo bookkeeping — the "everyday persistence" half of
 * PersonalAssistant, split out in Phase 4d of the architecture remediation plan. `fileTools`/
 * `shellTools` are the same shared option objects AgentLoop also holds (needed here for the
 * shell-result-cache clear in clearSession, and the workspace lookup in undo/sweep) — not a
 * duplication, just two collaborators independently needing the same read-only context.
 */
export declare class AssistantSession {
    private readonly memory;
    private readonly checkpointStore;
    private readonly spendCap;
    private readonly model;
    private readonly fileTools;
    private readonly shellTools;
    private readonly actionTools;
    private readonly notifiedContradictions;
    constructor(memory: MemoryAdapter, checkpointStore: CheckpointStore, spendCap: SpendCapConfig | undefined, model: () => string | undefined, fileTools: FileToolsContext | undefined, shellTools: ShellToolsContext | undefined, actionTools: ActionToolsContext | undefined);
    private static notifiedContradictionsKey;
    private static standingConstraintsKey;
    /** Constraints the user stated earlier in this session ("Do not use tabs") — they govern later turns too. */
    getStandingConstraints(sessionId: string): Promise<string[]>;
    /** Drops the standing constraints at these 1-based positions (as shown to the classifier); returns what remains. */
    liftStandingConstraints(sessionId: string, positions: readonly number[]): Promise<string[]>;
    /** Adds constraints stated this turn to the session's standing list; returns the merged list. */
    recordStandingConstraints(sessionId: string, stated: readonly string[]): Promise<string[]>;
    getNotifiedContradictions(sessionId: string): Promise<Set<string>>;
    recordNotifiedContradiction(sessionId: string, seen: Set<string>, value: string): Promise<void>;
    /** findContradictionNotice's own text, deduped once per session — see notifiedContradictions'
     * doc comment and findContradictionNotice's for why this exists: without it, the always-on
     * lexical Contradiction layer re-fires the identical notice on every subsequent non-trivial
     * turn, since the WorldModel it runs against is rebuilt fresh (re-seeded from all known facts)
     * each turn with no memory of its own that this exact conflict was already surfaced. */
    dedupedContradictionNotice(sessionId: string, layerActivity: LayerActivityEvent[], extraContradictions?: ExternalContradictionInput[]): Promise<string | undefined>;
    /** Persisted alongside transcript/facts/plan (this.memory) — survives a process restart, same as everything else keyed by sessionId, so the ceiling is genuinely cross-session, not just cross-turn within one process lifetime. */
    getSpendState(sessionId: string): Promise<SpendState>;
    /**
     * Pre-turn spend-cap check — a no-op (`{ allowed: true }`) whenever no cap is configured. Only
     * ever checked before a turn starts, never mid-turn (see spend-cap.ts's checkSpendCap doc
     * comment) — `turn()` skips this entirely for a pendingActionId continuation, since that's a
     * resumption of a turn that already passed this check when it first started.
     */
    checkSpendCapForTurn(sessionId: string): Promise<{
        allowed: boolean;
        reason?: string;
    }>;
    /**
     * Called once per successfully completed ('ok') turn — counts turns, not raw internal LLM
     * calls (see SpendCapConfig's doc comment for why). Estimates cost the same way turn-cost.ts's
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
    /** Tail of the chain serialising recordSpend's read-modify-write: the background memory reviewer records spend while a turn does, and the later write used to drop the other's cost. */
    private spendChain;
    recordSpend(sessionId: string, usage: TokenUsage | undefined): Promise<void>;
    private recordSpendNow;
    /** Read-only — null means plan mode has never been entered (or was already exited/cancelled) for this session (or this `threadId`, once Phase 5's per-thread rescoping applies — see `planModeKey`). */
    getPlanModeState(sessionId: string, threadId?: string): Promise<PlanModeState | null>;
    /**
     * The one place `planMode.active` ever flips true — a fresh `draftId` per entry, even if a
     * prior drafting session was cancelled without ever reaching approval, so a stale draftId can
     * never be mistaken for the current one. Idempotent to call again while already active (returns
     * a new state, same as a fresh entry) — callers that only ever call this once per drafting
     * session (P3's future auto-trigger) never observe that.
     */
    enterPlanMode(sessionId: string, threadId?: string): Promise<PlanModeState>;
    /** Clears `planMode.active` — the only two designed callers are an explicit cancel phrase (PlanDraftingService) and P2's future approval resolution. */
    exitPlanMode(sessionId: string, threadId?: string): Promise<void>;
    /** The session's conversation transcript, oldest first — same array `turn()` reads/appends to. Used by `/export`. */
    getTranscript(sessionId: string): Promise<ChatMessage[]>;
    /**
     * Reads `sessionId`'s transcript and runs it through transcript-compaction.ts's compactTranscript,
     * persisting the compacted array back when compaction actually collapsed anything — the first
     * thing `runTurn()` did with the raw transcript before this split. Kept on AssistantSession
     * (rather than the sequencer reading `memory` directly) so this remains the one place that reads
     * `transcript:${sessionId}` for a live turn.
     */
    loadAndCompactTranscript(sessionId: string, 
    /** AUDIT_SEMANTIC_COMPACTION: summarizes the older messages instead of truncating them (semantic-compaction.ts). */
    summarize?: (older: ChatMessage[]) => Promise<string | null>, 
    /** AUDIT_EPISODIC_DIGEST: called with exactly the messages about to be dropped, before they are (M3 pre-compaction flush). Fail-open: a throw never blocks compaction. */
    flush?: (older: ChatMessage[]) => Promise<unknown>): Promise<ChatMessage[]>;
    /**
     * Appends `message` to `transcriptKey`'s array — every site that used to call
     * `this.memory.set(transcriptKey, message, 'append')` directly now goes through here instead, so
     * a per-message search index entry (transcript-msg:<sessionId>:<n> — see messageIndexKey) is
     * always written alongside it, with no call site able to forget. The index write is best-effort:
     * caught and logged, never thrown — a search-indexing problem must never be able to break an
     * ordinary turn or lose the transcript message itself.
     */
    /**
     * A message the user sent while a turn was running that the turn's model call already took into account
     * (a mid-turn steering note). It belongs in the conversation as its own user message, in order: held here
     * and written just before the next assistant message, i.e. after the running turn's own user message and
     * before the reply it shaped. Without this the note vanished from the transcript.
     */
    recordAbsorbedSteering(sessionId: string, message: string): void;
    private readonly absorbedSteering;
    /**
     * Called by ResponseService the moment a turn's final reply is stored, before the slower post-reply work
     * (fact recording, goal evidence, grounding check) that still has to finish inside the turn. The assistant uses it
     * to put the reply in the activity log right away (benchmark issue N2).
     */
    replyReadyHook?: (sessionId: string, reply: string) => void;
    replyReady(sessionId: string, reply: string): void;
    appendTranscriptMessage(sessionId: string, transcriptKey: string, input: {
        role: 'user' | 'assistant';
        content: string;
        actionRecord?: string[];
    }): Promise<void>;
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
    backfillMessageIndex(): Promise<void>;
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
    sweepAbandonedPendingActionsOnStartup(): Promise<void>;
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
    recordDeclinedRequest(sessionId: string, userMessage: string, reason: string): Promise<void>;
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
    clearSession(sessionId: string): Promise<void>;
    /**
     * Scoped recovery for a stuck harness checkpoint: clears just `turn:${sessionId}`'s checkpoint
     * (and its resume-attempt count) without touching transcript/facts/plan — unlike clearSession
     * (`/clear`/`/new`), which wipes the whole conversation. Returns `{ cleared: false }` when there
     * was nothing to clear, so a caller can report "nothing stuck" instead of a false "cleared".
     */
    clearCheckpoint(sessionId: string): Promise<{
        cleared: boolean;
        stepsUsed?: number;
        currentNode?: string;
    }>;
    /**
     * Read-only counterpart to clearCheckpoint — reports whether `sessionId` has a checkpoint left
     * behind by a prior turn and how many times in a row it has already failed to resume, without
     * clearing anything. Lets a caller (cli.ts's `/checkpoint`) inspect before deciding whether to
     * clear.
     */
    getCheckpointStatus(sessionId: string): Promise<{
        present: boolean;
        stepsUsed?: number;
        currentNode?: string;
        failedResumeAttempts: number;
    }>;
    /**
     * Removes the most recent exchange from conversation history — a completed turn drops its
     * user message and assistant reply (2 entries); a turn that ended in `needs_approval` before
     * any reply was appended drops just the pending user message (1 entry). Only affects what the
     * model remembers: a real `write_file`/`run_shell_command` effect from the undone turn is not
     * reversed. Returns `{ undone: false }` on an empty transcript instead of throwing.
     */
    undoLastTurn(sessionId: string): Promise<{
        undone: boolean;
    }>;
    /** The workspace backend/root a staged write/shell/revert action lives under — `undefined` when neither fileTools nor shellTools is configured (e.g. a webTools-only assistant). Public: also used by ActionApprovalService for the same lookup. */
    undoWorkspace(): {
        backend: FsBackend;
        workspaceRoot: string;
    } | undefined;
    /** Real filesystem effects still on record as revertible, newest first — bounded by action-snapshot.ts's UNDO_LOG_MAX_ENTRIES retention cap. Backs `/undo-action` with no argument. Distinct from `/undo` (undoLastTurn above), which only forgets conversation history — see README's /undo-action section for the naming distinction. */
    listUndoLogEntries(): Promise<UndoLogEntry[]>;
    /**
     * Stages a revert of undo-log entry `id` as its own approval-gated `PendingActionPayload` —
     * reusing the exact same staging/approval machinery write_file/run_shell_command already use,
     * rather than a new confirmation concept. Approve/decline it the same way any other staged
     * action resolves: `turn('', { sessionId, approved, pendingActionId })`.
     */
    stageUndoAction(id: string): Promise<{
        status: 'staged';
        pendingActionId: string;
        reason: string;
    } | {
        status: 'error';
        message: string;
    }>;
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
    searchTranscript(query: string, topK?: number): Promise<TranscriptSearchHit[]>;
}
