import { ExperienceStore, StrategyWeightKey, DecompositionEntry, RecoverySequenceEntry, ExperienceStoreData, ExternalContradictionInput } from '@buildaharness/harness';
import { MemoryAdapter, ReminderStore, ReminderRecord, ILLMClient, TokenUsage, ChatMessage } from '@buildaharness/runtime';
import { UserFact } from './fact-extraction.js';
import { Corroboration } from './contradiction-checker.js';
import { DigestStore, SessionDigest } from './episodic-digest.js';
import { StatedFact, FactCategory } from './turn-intent-classifier.js';
import { EventSink, EventFilter, MemoryEvent } from './memory-events.js';
import { MemoryWriteMode, CrossTurnWriter } from './memory-governance.js';
import { ConsolidationProposal } from './memory-consolidation.js';
import { VerifiedReviewOp } from './memory-reviewer.js';
export declare const FACT_CAP = 20;
/** Default character budget for the rendered facts block under `AUDIT_MEMORY_BUDGETED_RENDER` (M0 measured ~195 tokens ≈ 800 chars for 20 facts; this leaves room for roughly 5x that). */
export declare const DEFAULT_MEMORY_BUDGET_CHARS: number;
/** Append-only store of entries a keyed fact replaced (M1); the M2 audit log will subsume it. */
export declare const RETIRED_FACTS_KEY: string;
/** M2: append-only change log with pre-images. Global, never cleared by `/new` (same convention as DURABLE_FACTS_KEY). */
export declare const AUDIT_LOG_KEY: string;
/** M2/M5: highest audit `seq` already consolidated; the audit log never rotates away an entry newer than this. Absent until M5 writes it. */
export declare const CONSOLIDATION_STATE_KEY: string;
/** M2: how many audit entries rotation keeps (plus any newer than the consolidation watermark). */
export declare const AUDIT_LOG_KEEP: number;
/**
 * M6: `/memory off` — when `{ off: true }`, nothing writes memory for this install (facts, pending
 * queue, and every later writer: M3 digests, M4 reviewer, M5 consolidation must check
 * `MemoryService.isMemoryOff()` first). Reads, forget, reject and undo still work: switching writes
 * off never traps the user's existing data. Global, never cleared by `/new`.
 */
export declare const MEMORY_OFF_KEY: string;
/** M5: staged proposals awaiting the user (`/memory consolidate`). Global, never cleared by `/new`. */
export declare const CONSOLIDATION_PROPOSALS_KEY: string;
/** M5: entries the user accepted an archive proposal for. Recoverable (`/memory archive restore`), never deleted by this phase. */
export declare const ARCHIVED_FACTS_KEY: string;
export type AuditOp = 'add' | 'replace' | 'retire' | 'remove' | 'confirm' | 'reject' | 'undo' | 'archive' | 'restore';
export interface AuditEntry {
    seq: number;
    at: string;
    op: AuditOp;
    /** `text|extractedAt` of the fact the entry concerns (M1's id convention). */
    factId: string;
    /** Pre-image (redacted text only — the gate redacts before anything reaches the log). */
    before?: UserFact;
    after?: UserFact;
    /** Which store the change was made to. */
    store: 'durable' | 'pending' | 'rejected';
    writer: string;
    turn: string;
    /** Set on an `undo` entry: the seq it reverted. */
    undoes?: number;
    /** M6: the user erased this fact from history (`/memory archive forget`); before/after were removed and the entry can no longer be undone. */
    erased?: boolean;
    /** Export only: the images of a forgotten fact are left out of `/memory export`; the stored log still has them so `/memory undo` works. */
    withheld?: boolean;
    /** M5: entries applied together (one consolidation proposal) share a group; undoing one undoes the group. */
    group?: string;
    /** M5: position the pre-image held in the durable list, so undo restores order exactly. */
    index?: number;
}
export declare const DURABLE_FACTS_KEY: string;
/**
 * Global, never cleared by `/new` — same retention shape as DURABLE_FACTS_KEY (a pending fact
 * shouldn't vanish just because the session changed). Phase 3 of
 * the internal plan: a `model_inferred` fact
 * that reached `durable: true, confidence: 'medium'` lands here instead of being silently
 * promoted or silently dropped — see `recordFacts()`'s promotion policy and
 * `confirmPendingFact()`/`rejectPendingFact()` below.
 */
export declare const PENDING_CONFIRMATION_KEY: string;
/**
 * Global, never cleared by `/new`. Holds facts removed from `facts:${sessionId}`/
 * PENDING_CONFIRMATION_KEY either by an entry-time retraction (a later statement contradicts an
 * unconfirmed guess — see `recordFacts()`) or by an explicit `/memory reject`. Rejected facts are
 * remembered, not blacklisted: the entry-time check compares new statements against this pool
 * too, so a matching restatement can re-enter PENDING_CONFIRMATION_KEY tagged
 * `previouslyRejected` instead of being silently re-asked forever or silently refused forever.
 */
export declare const REJECTED_FACTS_KEY: string;
/** Bound on how many learned decompositions/recovery sequences `getMemorySummary()` includes — see MemorySummary's doc comment. */
export declare const MEMORY_SUMMARY_PREVIEW_LIMIT = 20;
/** A `model_inferred` fact sitting in PENDING_CONFIRMATION_KEY, awaiting `/memory confirm`/`/memory reject`. */
export interface PendingFact extends UserFact {
    category: FactCategory;
    /** True when this exact fact previously lived in REJECTED_FACTS_KEY and was corroborated back in by a later, differently-phrased restatement — see `recordFacts()`'s corroboration handling. `/memory` surfaces this so the user sees the prior rejection instead of the fact looking brand new. */
    previouslyRejected?: boolean;
    /** M4: `retire` marks a reviewer proposal to retire an existing durable fact (`retireTargetId` = its `text|extractedAt`) rather than add one; confirming it retires, never adds. */
    proposedOp?: 'retire';
    retireTargetId?: string;
    /** M4: who staged this entry and what the semantic verifier said, shown in `/memory`. */
    stagedBy?: 'reviewer';
    verification?: 'supported' | 'unsupported' | 'not_checked';
}
/** What `stageReviewerOps()` did with a batch, for tests and `/memory` diagnostics. */
export interface StageReviewerResult {
    staged: number;
    /** Unsupported by the verifier, kept session-scoped only. */
    sessionScoped: number;
    /** Refused by a plain-code gate (retire of a user_asserted fact, unknown target) or dropped by the write gate. */
    refused: number;
    /** The signal fired before the write: nothing was written. */
    aborted: boolean;
}
/** An entry in REJECTED_FACTS_KEY — see that constant's doc comment. */
export interface RejectedFact {
    text: string;
    rejectedAt: string;
    rejectionSource: 'auto_retracted' | 'user_explicit';
}
/**
 * Read-only snapshot returned by `getMemorySummary()` — see that method's doc comment.
 * `decompositions`/`recoverySequences` are capped at the 20 most recently learned entries
 * (newest first) so `/memory` stays scannable after months of accumulated learning; `/memory
 * export` (see `exportMemory()`) returns every category unbounded, since a file on disk doesn't
 * have the same terminal-scrollback concern a REPL print does. `pending`/`rejected` are their
 * stores' full, unbounded contents — neither is expected to grow anywhere near
 * MEMORY_SUMMARY_PREVIEW_LIMIT in practice, unlike decompositions/recoverySequences.
 */
export interface MemorySummary {
    facts: UserFact[];
    reminders: ReminderRecord[];
    pending: PendingFact[];
    experience: {
        strategyWeights: Record<StrategyWeightKey, number>;
        decompositions: DecompositionEntry[];
        recoverySequences: RecoverySequenceEntry[];
    };
}
/** Full, unbounded snapshot written by `/memory export` — every ExperienceStore category plus facts/reminders/pending-confirmation, as plain JSON. */
export interface MemoryExport {
    exportedAt: string;
    facts: UserFact[];
    reminders: ReminderRecord[];
    pending: PendingFact[];
    experience: ExperienceStoreData;
    /** M3: every stored episodic digest, unbounded and regardless of retention. */
    digests?: SessionDigest[];
    /** M6: facts a keyed update replaced (and, after M5, archived) — covered by export so nothing the assistant holds about the user is missing from it. */
    retired?: UserFact[];
    /** M6: the audit log (redacted text only, by the M2 gate). Empty when the audit-log flag is off. */
    audit?: AuditEntry[];
    /** M6: governance state at export time. */
    governance?: {
        mode: MemoryWriteMode;
        off: boolean;
    };
}
/** M6: what the facts block of the most recent turn actually contained ("Why?" panel, `/why`). */
export interface MemoryInjection {
    /** Facts placed in the prompt, in render order. */
    facts: {
        text: string;
        unconfirmed: boolean;
    }[];
    /** In-scope live facts that did NOT make it into the prompt (budget or the legacy 20-fact cap). */
    notShown: number;
}
/** M6: store-health snapshot for `/doctor` and the memory panel. Read-only; never touches usage counters. */
export interface MemoryStatus {
    mode: MemoryWriteMode;
    off: boolean;
    budgetedRender: boolean;
    budgetChars: number;
    /** Characters the in-scope live facts would need if all were rendered. */
    storeChars: number;
    liveFacts: number;
    pending: number;
    flaggedPending: number;
    retired: number;
    auditEnabled: boolean;
    auditEntries: number;
    /** Highest audit seq already consolidated (M5 writes `memory:consolidation-state`); undefined until then. */
    lastConsolidatedSeq?: number;
    lastConsolidationAt?: string;
    lastInjection?: MemoryInjection;
}
/** M6 extension point for M5: what a consolidation run reports back to `/memory consolidate`. */
export type ConsolidationOutcome = {
    status: 'done';
    message: string;
} | {
    status: 'nothing_to_do';
    message: string;
};
/** M5 registers one of these via `MemoryService.registerConsolidator()`; it proposes through `submit` so governance, the gate and the audit log apply. */
export type MemoryConsolidator = (ctx: {
    submit: MemoryService['submitCandidate'];
    sessionId: string;
}) => Promise<ConsolidationOutcome>;
/** Result of a single fact's promotion-time (`/memory confirm`) or corroboration-driven (medium→high) admission into DURABLE_FACTS_KEY — see `confirmPendingFact()`. */
export interface PendingConfirmationOutcome {
    fact: UserFact;
    /** Set when the promotion-time check (checkForContradictions against current Knowledge) found a conflict — advisory only, matching every other contradiction check in this codebase: the promotion still succeeds regardless. */
    conflictNotice?: string;
}
/** `recordFacts()`'s return — see its doc comment's "Ordering constraint" note on why callers must read this before building any contradiction notice for the turn. */
export interface RecordFactsResult {
    contradictions: ExternalContradictionInput[];
    corroborations: Corroboration[];
}
/**
 * `AUDIT_MEMORY_BUDGETED_RENDER` gate (M1 of the agent memory framework plan). Gates budgeted/
 * priority rendering, keyed supersession and usage fields. `=0`/`off` restores `slice(-FACT_CAP)`
 * and append-only writes. Default **ON** (M7 corrections scenario, 2 of 2 seeds: lexicalOff FAIL, memoryM12On PASS);
 * `0`/`false`/`off`/`no`/`disabled` restores the legacy path. Read fresh each call; this is the one read point.
 */
export declare function memoryBudgetedRenderEnabled(env?: Record<string, string | undefined>): boolean;
/** `AUDIT_MEMORY_WRITE_GATE`: semantic secret redaction + injection judgement before promotion, failing closed. Default OFF until the real-model pilot (plan defaults rule); `1/true/on/yes/enabled` enables. */
export declare function memoryWriteGateEnabled(env?: Record<string, string | undefined>): boolean;
/** `AUDIT_MEMORY_AUDIT_LOG`: append-only `memory:audit`. Default OFF until the pilot; `=0` restores the unlogged path. */
export declare function memoryAuditLogEnabled(env?: Record<string, string | undefined>): boolean;
/** `AUDIT_MEMORY_EVENTS`: metadata-only transition events (kind, reason code, source refs, ids; no fact text unless the audit log is on). Default ON; `=0`/`off` restores no events. */
export declare function memoryEventsEnabled(env?: Record<string, string | undefined>): boolean;
/** Outcome of `admitCandidate()` for one candidate. `session` = kept session-scoped only, never durable or pending. */
export interface AdmitDecision {
    action: 'admit' | 'session' | 'flag' | 'drop';
    fact: UserFact;
}
/**
 * The single judgement step every writer's candidate passes through before it can be promoted (M2).
 * Pure: the judgements were produced by the same LLM call that produced the fact. Always strips the
 * transient `judgement`. With the gate off the candidate is returned unchanged (`admit`). With it on,
 * for a `model_inferred` candidate: a missing judgement fails closed (`session`, durable bit cleared);
 * a secret is replaced by the model's secret-free text, or dropped when the claim is the secret; an
 * instruction-shaped claim is `flag`ged for the pending queue. A non-`user` origin never promotes.
 */
export declare function admitCandidate(candidate: UserFact, gateOn: boolean): AdmitDecision;
/** Removes verbatim copies of the injected memory block from text bound for candidate extraction (feedback-loop prevention). Structural: it removes the exact block this service rendered, not a pattern. */
export declare function excludeInjectedBlock(text: string, injectedBlock: string): string;
export interface RenderedFacts {
    block: string;
    /** Facts actually placed in the block, in render order. */
    shown: UserFact[];
    /** In-scope live facts that did not fit the budget. */
    droppedCount: number;
}
/**
 * Renders facts by priority and character budget, not by position: identity/preference first, then
 * semantic, then episodic/session facts; within a tier newest statement first, then most recently
 * injected. A fact is dropped only when the budget is spent, and the drop is counted. No
 * query-relevance ranking (D2: no lexical scoring). Pure.
 */
export declare function renderFactsBlock(inScope: UserFact[], budgetChars: number): RenderedFacts;
/**
 * `AUDIT_MODEL_INFERRED_FACTS` gate — feature-value audit (Phase C3 of the internal plan).
 * Default **ON**: `classifyTurnIntent`'s `statesDurableFacts` (source `model_inferred`) reach
 * memory today, so an unset / empty / truthy value keeps that behaviour. Set to a falsy value
 * (`0` / `false` / `off` / `no` / `disabled`) to drop them, leaving only the lexical
 * `user_asserted` pass. Gates the *consumption* of the classifier's facts, not the classifier call
 * (which also produces the intent/risk fields every arm needs). Read at exactly one call site —
 * `buildTurnFacts()` below. Same shape as `semanticContradictionEnabled()` (contradiction-checker.ts).
 */
export declare function modelInferredFactsEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * The exact lexical+LLM merge `recordFacts()` uses to decide what to write to the fact stores,
 * exposed (Phase 4 of the internal plan) so a
 * caller can seed `HarnessRunParams.currentTurnFacts` (harness-bridge.ts's `factExtractor`) with
 * the identical merged, deduplicated list — instead of harness-bridge.ts recomputing only the free
 * lexical half and never seeing an LLM-caught fact at all, which left a same-turn LLM-caught fact
 * invisible to contradiction detection. Two independent calls with the same arguments (one here to
 * build a harness run's currentTurnFacts before the run, one inside `recordFacts()` itself after
 * it) each stamp their own `extractedAt` — harmless, since neither call's result is compared
 * against the other's by identity.
 */
export declare function buildTurnFacts(sessionId: string, userMessage: string, statedFacts: StatedFact[], policyEnabled?: boolean, now?: () => string): UserFact[];
/**
 * Owns fact/reminder/experience reads that feed each turn's system prompt, fact capture, and the
 * `/memory`/`/memory export` read-only snapshots — the "what has this assistant learned" surface
 * of PersonalAssistant, split out in Phase 4d of the architecture remediation plan. `llmClient`/
 * `model` were added in Phase 3 of the fact-extraction-confidence plan — `recordFacts()`'s
 * entry-time consistency check and the promotion-time check in `confirmPendingFact()` both run
 * the same `checkForContradictions` the harness's own per-turn contradiction hook already uses,
 * rather than building a second mechanism.
 */
export declare class MemoryService {
    private readonly memory;
    private readonly reminderStore;
    private readonly experienceStore;
    private readonly llmClient;
    private readonly model;
    /** Resolves to `config.activeProject` if the user set one via `/project <name>`, else the workspace root — read through a getter (same convention as `model` above) so a mid-session `/project`/`/config set activeProject` change takes effect on the very next turn. See UserFact.project's doc comment for how this is used. */
    private readonly currentProject;
    /** M1: character budget for the facts block under `AUDIT_MEMORY_BUDGETED_RENDER` (config `memoryBudgetChars`). */
    private readonly memoryBudgetChars;
    /** M6: governance mode (config `memoryWriteMode`), read through a getter like the others so a live change applies on the next write. Resolved here and nowhere else. */
    private readonly writeMode;
    /** Time source for every timestamp this service writes (extractedAt of stated facts, audit `at`, retiredAt, usage flush). Injectable so the cross-runtime conformance fixtures are byte-reproducible; default is wall-clock, i.e. no behaviour change. */
    private readonly clock;
    /** Every fact list goes through this seam (see fact-repository.ts); the key-value implementation keeps today's keys. */
    private readonly repo;
    constructor(memory: MemoryAdapter, reminderStore: ReminderStore, experienceStore: ExperienceStore, llmClient: ILLMClient, model: () => string | undefined, 
    /** Resolves to `config.activeProject` if the user set one via `/project <name>`, else the workspace root — read through a getter (same convention as `model` above) so a mid-session `/project`/`/config set activeProject` change takes effect on the very next turn. See UserFact.project's doc comment for how this is used. */
    currentProject?: () => string, 
    /** M1: character budget for the facts block under `AUDIT_MEMORY_BUDGETED_RENDER` (config `memoryBudgetChars`). */
    memoryBudgetChars?: () => number, 
    /** M6: governance mode (config `memoryWriteMode`), read through a getter like the others so a live change applies on the next write. Resolved here and nowhere else. */
    writeMode?: () => MemoryWriteMode, 
    /** Time source for every timestamp this service writes (extractedAt of stated facts, audit `at`, retiredAt, usage flush). Injectable so the cross-runtime conformance fixtures are byte-reproducible; default is wall-clock, i.e. no behaviour change. */
    clock?: () => string);
    private consolidator?;
    private lastInjection?;
    /** `/memory off` state — M3/M4/M5 writers must call this before any write or LLM spend. */
    isMemoryOff(): Promise<boolean>;
    setMemoryOff(off: boolean): Promise<void>;
    /** M5 extension point (not built here): until a consolidator is registered `/memory consolidate` says so instead of pretending. */
    registerConsolidator(fn: MemoryConsolidator | undefined): void;
    consolidate(sessionId: string): Promise<ConsolidationOutcome | {
        status: 'unavailable' | 'blocked';
        message: string;
    }>;
    /**
     * M6 extension point for M3 (digest), M4 (reviewer) and M5 (consolidation) writers: the ONE way a
     * cross-turn candidate enters memory. It applies, in order: `/memory off`, the M2 gate
     * (`admitCandidate`: redaction, injection flag, fail-closed judgement, non-user origin), then the
     * governance route for `memoryWriteMode` (`resolveWriteRoute`), and writes through the same
     * single durable commit point / pending queue / audit log as every other writer. Add-only: removal
     * and retirement stay with the user or a staged proposal.
     */
    submitCandidate(writer: CrossTurnWriter, candidate: UserFact, sessionId: string, opts?: {
        pendingExtras?: Partial<PendingFact>;
        forceGate?: boolean;
    }): Promise<{
        route: 'durable' | 'pending' | 'session' | 'dropped' | 'blocked';
        fact?: UserFact;
    }>;
    /** Facts rendered since the last flush, keyed by `text|extractedAt`; written lazily so loadFacts() stays read-only (M1). */
    private pendingInjections;
    /** Number of in-scope facts the last budgeted render could not show — `/memory` says "N facts not shown this turn". */
    lastDroppedCount: number;
    /** The facts block most recently rendered into a prompt; excluded verbatim from candidate extraction (M2 feedback-loop prevention). */
    private lastInjectedBlock;
    private digestStoreInstance?;
    /** Incremented whenever recordFacts() or stageReviewerOps() changes any memory store; the M4 trigger compares it before and after a turn. */
    writeCount: number;
    /** The facts block most recently injected into a prompt (what the M4 reviewer must strip from its input). */
    getInjectedBlock(): string;
    /**
     * Keys of the live durable facts, with their text, for the classifier prompt (M1 key stability:
     * the model reuses a stored key for a new value of the same attribute instead of inventing a
     * variant that would miss supersession). Newest first, capped so the prompt stays small. Empty
     * when keyed supersession is off.
     */
    getKnownFactKeys(limit?: number): Promise<{
        key: string;
        text: string;
    }[]>;
    /** Durable facts in stored order — the list a reviewer `retire` op's `targetId` indexes into. */
    getDurableFacts(): Promise<UserFact[]>;
    /**
     * M4: stages the post-turn reviewer's operations. Per decision D1 nothing here reaches durable memory: surviving ops
     * wait in the pending queue with their evidence (shown by `/memory`). Plain-code gates, no language judgement:
     * a `retire` of a `user_asserted` fact (or of an unknown target) is refused; every op passes `admitCandidate()`;
     * an op the verifier called unsupported is kept session-scoped only. All writes happen after the abort check, in one
     * batch per store, so an abort leaves no partial write. `durableSnapshot` is the list the reviewer's `targetId`s index.
     */
    stageReviewerOps(sessionId: string, ops: readonly VerifiedReviewOp[], durableSnapshot: readonly UserFact[], signal?: AbortSignal): Promise<StageReviewerResult>;
    /**
     * M2: the ONLY place `DURABLE_FACTS_KEY` is written. Every add, replace, retire, remove, confirm
     * and usage-flush goes through here, so a new writer cannot skip the audit log. A structural test
     * (memory-write-gate.test.ts) asserts this is the only call in the file that writes the durable key.
     */
    private commitDurable;
    /** Tail of the in-process chain serialising the audit log's read-modify-write (concurrent appends lost entries and reused seq numbers). */
    private auditChain;
    /** Same for the usage flush's read-modify-write of the fact stores. */
    private flushChain;
    private serialized;
    private appendAudit;
    /** Extra destinations for events (the eval collector); each receives every event, whether or not the stored log is on. */
    private eventSinks;
    private eventSeqLocal;
    addEventSink(sink: EventSink): void;
    /** Stamps seq/at, appends to the stored event log (when `AUDIT_MEMORY_EVENTS` is on) and fans out to the extra sinks. A sink that throws never blocks the memory write. */
    private emitEvents;
    /** `/memory history events [fact]`: the newest transition events, optionally for one fact id or attribute key. */
    getEvents(limit?: number, filter?: EventFilter): Promise<MemoryEvent[]>;
    /** A decision that wrote nothing (a promotion declined, a duplicate, a contradiction found) still leaves an event. */
    private decisionEvent;
    private appendAuditNow;
    /** `/memory history` — newest last; the last `limit` entries. */
    getAuditLog(limit?: number): Promise<AuditEntry[]>;
    /**
     * `/memory undo <seq>` — restores the pre-image of one audit entry exactly (and removes what that
     * entry added), then appends an `undo` entry. An entry can be undone once. Returns a message for
     * the caller, or undefined when the seq is unknown.
     */
    undoAudit(seq: number, sessionId?: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** Undo of the change that created a side store must leave it absent again, not an empty array (exact restoration). */
    private setOrClear;
    private undoEntry;
    /**
     * Durable + session facts for `sessionId`, plus the ready-to-splice system-prompt block — see
     * runTurn's former factsBlock. `facts` is the full inventory, unfiltered by project — `/memory`
     * (getMemorySummary) needs to show and let the user forget a fact regardless of which project is
     * currently active. `factsBlock` — what the model actually sees this turn — filters to
     * global-or-current-project only, so an unrelated project's facts don't leak into context (see
     * UserFact.project's doc comment).
     */
    loadFacts(sessionId: string, opts?: {
        record?: boolean;
    }): Promise<{
        facts: UserFact[];
        factsBlock: string;
        knownFactKeys: {
            key: string;
            text: string;
        }[];
    }>;
    /**
     * `/memory forget <n>` — removes the nth entry (1-based in `/memory`'s "Facts I know" display,
     * 0-based here) from whichever store(s) it actually lives in. `index` is over the same merged,
     * durable-first ordering `loadFacts()`/`getMemorySummary()` already produce, so the number a user
     * sees in `/memory` is the number they pass here — no separate "durable index" vs "session index"
     * to track. A fact that's both durable and session-scoped under an identical restated text (see
     * mergeFacts's dedup) is removed from both stores by `sameFact` identity, not just the copy that
     * happened to win the display dedup. Returns undefined for an out-of-range index (the caller's
     * `/memory` view is stale — nothing to forget).
     */
    forgetFact(index: number, sessionId: string, erase?: boolean): Promise<UserFact | undefined>;
    /**
     * reminderStore is cross-session durable (clearSession() never touches it, same tier as
     * DURABLE_FACTS_KEY) but, unlike facts, was never actually surfaced into context: a plain
     * conversational question about a previously-created reminder ("did I mention X earlier?") got
     * no grounding unless the model happened to call list_reminders itself — found via live
     * testing (a fresh /new session flatly denied any record of a reminder created in the prior
     * session, and separately claimed "I don't have access to other conversations" in the same
     * reply that a durable *fact* from that same prior session correctly informed). Only undone
     * reminders: a completed one is no longer something the user would expect the assistant to
     * "remember" as pending.
     */
    loadActiveReminders(): Promise<{
        activeReminders: ReminderRecord[];
        remindersBlock: string;
    }>;
    /**
     * Captures this turn's durable/session facts into the session's fact store. A no-op when
     * neither pass finds anything. Facts routed to durable by `resolveWriteRoute()` (memory-governance.ts; see its doc
     * comment for the current three-way policy) are ALSO appended to DURABLE_FACTS_KEY, a store
     * clearSession() never touches, so they survive /new instead of vanishing with the rest of the
     * session's facts. A `model_inferred` fact at `durable: true, confidence: 'medium'` is queued
     * to PENDING_CONFIRMATION_KEY instead (Phase 3) — never auto-promoted, never dropped.
     *
     * Phase 2: the free lexical pass (`extractFactsFromTurn`) and `classifyTurnIntent`'s
     * `statesDurableFacts` (the `StatedFact[]` list this method's `statedFacts` param carries) are
     * **both always considered**, merged via `mergeTurnFacts()`. The lexical pass keeps running
     * unconditionally so a classifier outage (an empty `statedFacts` list, per
     * `failSafeClassification`) still degrades to "regex only," never to "no facts at all."
     *
     * Phase 3: every write this function performs passes through the entry-time consistency check
     * first — this turn's new facts are checked, in one batched `checkForContradictions` call, both
     * against Knowledge (durable + session facts already in the Knowledge tier — see
     * `tierForFact`/`isKnowledgeTier`) and against the session's current medium/low-confidence
     * `model_inferred` facts (the "uncertain pool"), plus REJECTED_FACTS_KEY (so a restated,
     * previously-rejected guess is recognized rather than treated as brand new). A contradiction
     * against the uncertain pool is a retraction: the retracted fact is removed from the session
     * store and PENDING_CONFIRMATION_KEY and recorded into REJECTED_FACTS_KEY instead. A
     * corroboration against the uncertain pool upgrades that fact's confidence in place
     * (low→medium queues it to PENDING_CONFIRMATION_KEY; medium→high promotes it to
     * DURABLE_FACTS_KEY) — corroboration is deliberately the one read-modify-write path in this
     * function; every other write is append-only. A corroboration against REJECTED_FACTS_KEY
     * re-queues the fact to PENDING_CONFIRMATION_KEY tagged `previouslyRejected`.
     *
     * **Ordering constraint on callers**: this must run, and its `contradictions` must be folded
     * into whatever contradiction notice the turn returns, BEFORE that notice is finalized — see
     * response-service.ts's three result-builders and assistant-session.ts's
     * `dedupedContradictionNotice`. Left uncalled, this phase's entry-time findings would be
     * computed but never surfaced in the turn's own reply.
     */
    recordFacts(sessionId: string, userMessage: string, statedFacts: StatedFact[], onUsage?: (usage: TokenUsage) => void): Promise<RecordFactsResult>;
    private consolidating;
    /**
     * M5: proposes consolidation and archive changes; applies NOTHING (D1: staged). Work is for the
     * stores as the previous session left them: callers run it at session start or `/new`, or on the
     * manual `/memory consolidate` (`manual` forces the model pass).
     *
     * Cost gate, deterministic and before any model call: the model pass runs only when the audit log
     * has entries newer than `memory:consolidation-state.lastSeq` or the curated (durable) store is
     * over the character budget, and there are at least two live facts; otherwise zero model calls.
     * Archive proposals use no model: only M1's usage timestamps and the retention window. A failed
     * or unusable model call changes nothing (the watermark does not move, so the next run retries).
     * Requires the audit log: a change that cannot be undone is never proposed.
     */
    runConsolidation(opts?: {
        manual?: boolean;
        onUsage?: (usage: TokenUsage) => void;
    }): Promise<{
        status: 'disabled' | 'needs_audit_log' | 'busy' | 'skipped' | 'ran' | 'failed';
        proposed: number;
        modelCalls: number;
        projectedChars?: number;
        usedChars?: number;
    }>;
    getConsolidationProposals(): Promise<ConsolidationProposal[]>;
    /** `/memory archive` — what staged forgetting has set aside. Nothing in it is deleted. */
    getArchivedFacts(): Promise<UserFact[]>;
    /** `/memory consolidate dismiss <n>`: drops the proposal and remembers its signature so it is not raised again. */
    dismissProposal(index: number): Promise<ConsolidationProposal | undefined>;
    /**
     * `/memory consolidate accept <n>`: the user's explicit yes. Applies one staged proposal to the
     * durable store through `commitDurable` as one audit group (`/memory undo <seq>` reverts all of it,
     * restoring the store and its order exactly). Merged/superseded originals go to the retired store,
     * archived ones to the archive store; nothing is deleted. Refuses without the audit log, and treats
     * a proposal whose facts changed since it was staged as stale.
     */
    acceptProposal(index: number, sessionId?: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** `/memory archive restore <n>`: puts an archived entry back among the live facts (audited; undoable). */
    restoreArchivedFact(listIndex: number, sessionId?: string): Promise<UserFact | undefined>;
    /** Writes the batched `injectedCount`/`lastInjectedAt` updates collected by budgeted renders, to whichever store(s) hold each fact. A no-op (no writes) when nothing was rendered. */
    private flushInjectionUsage;
    private flushInjectionUsageNow;
    /**
     * `/memory confirm <n>` — promotes the nth (1-based in `/memory`'s display, 0-based here) entry
     * in PENDING_CONFIRMATION_KEY to DURABLE_FACTS_KEY. Runs the same promotion-time check as
     * corroboration's medium→high path: entering DURABLE_FACTS_KEY is itself a store-write, checked
     * against current Knowledge at the moment of promotion rather than deferred to the next turn's
     * re-seed. A conflict is advisory only — the confirm still succeeds regardless, matching every
     * other contradiction check in this codebase (never gates belief admission); the conflict is
     * returned as `conflictNotice` for the caller to surface. Returns undefined for an out-of-range
     * index (the caller's `/memory` view is stale — nothing to confirm).
     */
    confirmPendingFact(index: number, onUsage?: (usage: TokenUsage) => void): Promise<PendingConfirmationOutcome | undefined>;
    /** `/memory reject <n>` — removes the nth pending entry and records it into REJECTED_FACTS_KEY with `rejectionSource: 'user_explicit'`. Returns undefined for an out-of-range index. */
    rejectPendingFact(index: number): Promise<PendingFact | undefined>;
    /** `/memory confirm <category>` — bulk-confirms every pending entry in one category, useful once a topic accumulates several related guesses the user would naturally want to resolve together. Runs the promotion-time check per fact (still one call per fact — matches confirmPendingFact's own guarantee, not batched across facts since each is an independent store-write with its own conflict outcome). */
    confirmPendingCategory(category: FactCategory, onUsage?: (usage: TokenUsage) => void): Promise<PendingConfirmationOutcome[]>;
    /** `/memory reject <category>` — bulk-rejects every pending entry in one category. */
    rejectPendingCategory(category: FactCategory): Promise<PendingFact[]>;
    private rejectFacts;
    private promoteConfirmedFact;
    /**
     * Read-only snapshot of what this session/assistant has learned: durable facts extracted
     * from the user's own messages, reminders created so far, pending-confirmation guesses, and the
     * real content (not just counts) of the learning-layer `ExperienceStore` — strategy weights in
     * full, and the 20 most recently learned decompositions/recovery sequences (see
     * MEMORY_SUMMARY_PREVIEW_LIMIT). Use `exportMemory()` for the full, unbounded contents. Used by
     * `/memory`.
     */
    getMemorySummary(sessionId: string): Promise<MemorySummary>;
    /**
     * Full, unbounded snapshot of everything learned so far — every ExperienceStore category
     * (not just the 20-entry preview `getMemorySummary()` bounds for terminal display) plus
     * facts/reminders/pending-confirmation, as plain JSON. Read-only: this adds no corresponding
     * import path, so a user cannot hand-edit the result and load it back in. Used by `/memory
     * export`.
     */
    exportMemory(sessionId: string): Promise<MemoryExport>;
    /** What the most recent turn's facts block contained (undefined before the first turn). Set only by the turn path, never by read-only views. */
    getLastInjection(): MemoryInjection | undefined;
    /** `/memory archive`: entries a keyed update replaced, newest first. M5 EXTENSION POINT: its archive store joins here (and in `exportMemory`) when it exists. */
    listArchive(): Promise<UserFact[]>;
    /**
     * `/memory archive forget <n>`: permanently erases one archived entry (index over `listArchive()`),
     * including its pre-images in the audit log (those entries stay, marked `erased`, and can no longer
     * be undone). The only path that edits the audit log other than appending, and only on an explicit user request.
     */
    forgetArchived(index: number): Promise<UserFact | undefined>;
    /** Strips one fact's pre/post-images from the audit log (entries stay, marked `erased`, and can no longer be undone) and unlinks `supersedes` references to it. */
    private eraseFromAuditLog;
    private eraseFromAuditLogNow;
    /** Read-only health snapshot (`/doctor`, memory panel). Never touches usage counters or the last-injection record. */
    getMemoryStatus(sessionId: string): Promise<MemoryStatus>;
    /** M3 (D4): `/memory forget digest <id>` or, with no id, every digest. Returns how many were removed. */
    forgetDigests(id?: string): Promise<number>;
    /** M3: read-only digest reader over the same store the recall tool uses. */
    get digests(): DigestStore;
    /** Token usage of the most recent digest/flush calls made by this service (cost per session edge). */
    digestUsage: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
    };
    private trackDigestUsage;
    /**
     * M3 session-edge digest (`/new`, exit). One bounded call, fail-open: any failure leaves the previous digest (if any)
     * untouched. Skipped when the conversation has no user message. Output is judged and redacted by `admitCandidate`
     * (see episodic-digest.ts) and stored at `episodic:<id>`; it never touches durable facts. Callers gate on
     * `episodicDigestEnabled()`; never call from inside a turn.
     */
    writeSessionDigest(sessionId: string, transcript: ChatMessage[], onUsage?: (usage: TokenUsage) => void): Promise<SessionDigest | null>;
    /** M3: ends the conversation's digest identity so the next conversation under the same session id gets a new digest. Call after `writeSessionDigest`. */
    endDigestConversation(sessionId: string): Promise<void>;
    /**
     * M3 pre-compaction flush: called with exactly the messages compaction is about to drop. One call extracts candidate
     * facts and a digest delta (folded into the conversation's digest). Candidates are judged by `admitCandidate` and go
     * to the pending queue only, never durable. Fail-open: returns 0 on any failure and compaction proceeds regardless.
     */
    flushBeforeCompaction(sessionId: string, older: ChatMessage[], onUsage?: (usage: TokenUsage) => void): Promise<number>;
    /** Judges flush candidates (gate forced on: a missing judgement drops the candidate) and appends the survivors to the pending queue. Exact-text duplicates of anything pending, durable or rejected are skipped. */
    private queueFlushCandidates;
}
