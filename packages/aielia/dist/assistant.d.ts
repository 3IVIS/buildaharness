import { ExperienceStore, CheckpointStore, AskResponse, LayerPolicyMode } from '@buildaharness/harness';
import { MemoryAdapter, ILLMClient, ChatMessage, ReminderStore } from '@buildaharness/runtime';
import { FileToolsContext } from './file-tools.js';
import { UndoLogEntry } from './action-snapshot.js';
import { WebToolsContext } from './web-tools.js';
import { ShellToolsContext } from './shell-tools.js';
import { ActionToolsContext } from './action-tools.js';
import { SpendCapConfig, SpendState } from './spend-cap.js';
import { WriterChatPort } from './writer/writer-chat-turn.js';
import { TraceEvent } from './trace-events.js';
import { AssistantToolStep } from './tool-step.js';
import { MemoryService, MemorySummary, MemoryExport, AuditEntry, MemoryStatus, MemoryInjection, ConsolidationOutcome } from './memory-service.js';
import { EventFilter, MemoryEvent } from './memory-events.js';
import { MemoryWriteMode } from './memory-governance.js';
import { ConsolidationProposal } from './memory-consolidation.js';
import { UserFact } from './fact-extraction.js';
import { TranscriptSearchHit } from './assistant-session.js';
import { SessionDigest } from './episodic-digest.js';
import { PlanDecision, PlanApprovalEdits } from './plan-approval-service.js';
import { PlanRecord } from './plan-store.js';
import { GoalGraphRecord } from './goal-graph-store.js';
import { OneLoopMode } from './one-loop-flag.js';
import { AskMode } from './ask-mode-flag.js';
import { AmbiguityGuardMode } from './ambiguity-guard-flag.js';
import { PlanRolloutMode } from './plan-mode-flag.js';
import { GoalGraphSuggestMode } from './goal-graph-suggest-flag.js';
import { GoalGraphState } from './goal-graph-service.js';
import { LiveSteeringChannel } from './live-steering-channel.js';
import { DebugLogEntry } from './debug-log.js';
import { AssistantTurnResult, AssistantProgress } from './assistant-types.js';
export type { MemorySummary, MemoryExport, PendingFact } from './memory-service.js';
export type { FactCategory } from './turn-intent-classifier.js';
export type { IndexedMessage, TranscriptSearchHit } from './assistant-session.js';
export type { GoalGraphState, GoalThreadView, GoalThreadVisibility, GoalTaskSummary } from './goal-graph-service.js';
export type { BatchBudgetState } from './agent-loop.js';
export { trimmedAverage, nextItemBudget } from './agent-loop.js';
export type { AssistantSource } from './assistant-source.js';
export type { DebugLogEntry } from './debug-log.js';
export type { AssistantTrace, AssistantTurnResult, AssistantProgress, ProposerKind } from './assistant-types.js';
export type { PlanDecision, PlanApprovalEdits } from './plan-approval-service.js';
export type { PlanMode } from './plan-store.js';
/** Result of `/memory confirm`/`/memory reject` (single index or bulk category) — see PersonalAssistant.confirmPendingFact/rejectPendingFact. */
export type MemoryPendingOutcome = {
    ok: true;
    facts: UserFact[];
    conflictNotices: string[];
} | {
    ok: false;
    error: string;
};
export interface TurnOptions {
    sessionId?: string;
    /** Internal: this turn is the one-time correction the reply audit asked for; it is not a user message and is never retried again. */
    auditRetry?: boolean;
    /** M4: a scripted / piped / batch caller. The post-turn memory reviewer is skipped for it (it only runs for an interactive session). */
    nonInteractive?: boolean;
    approved?: boolean;
    pendingActionId?: string;
    /**
     * Q2 of the internal plan — resolves a staged `needs_clarification`
     * result (see AssistantTurnResult.pendingClarificationId) with the user's answer. Mirrors
     * `pendingActionId`/`approved`'s own "resolved by ID, never re-derived" shape:
     * `clarificationAnswer` must answer exactly the questions that were staged, validated
     * server-side (INV-28) regardless of what the client already checked.
     */
    pendingClarificationId?: string;
    clarificationAnswer?: AskResponse;
    /**
     * P2 of the internal plan — resolves a staged `needs_plan_approval`
     * result (see AssistantTurnResult.planApprovalId) with the user's decision. Mirrors
     * `pendingActionId`/`approved`'s "resolved by ID, never re-derived" shape: what gets
     * approved/declined is exactly the plan that was staged, never re-drafted.
     */
    planApprovalId?: string;
    /** `'approve'`/`'approve_with_edits'`/`'decline'` — required to resolve `planApprovalId`; omitting it leaves the plan `awaiting_approval` (fail closed), same as an unanswered clarification. */
    planDecision?: PlanDecision;
    /** Only meaningful with `planDecision: 'approve_with_edits'` — cancels/edits applied before the plan is activated. */
    planEdits?: PlanApprovalEdits;
    /**
     * Per-session override — tier 2 of Q1's three-tier INV-29 resolution. `'disabled'` forces
     * plain free-text-fallback escalations for this turn even when the global `askMode` config is
     * `'enabled'`. Absent/`'enabled'` defers to the global flag. Never widens the global flag: an
     * override can only turn structured questions off relative to it, never on when the global
     * flag is off.
     */
    askMode?: AskMode;
    /**
     * Stops the turn: once it fires, no further model call starts or is kept, the transcript is left as it was before
     * the turn, and `turn()` resolves with `status: 'cancelled'` right away. Ignored when resuming a staged action
     * (`pendingActionId`), because that applies a write/shell/email the user already approved and must not be half-done.
     */
    signal?: AbortSignal;
    onProgress?: (progress: AssistantProgress) => void;
    /**
     * Called with each token as the model's reply streams in. On the plain chat
     * path (no tool loop active) this is the turn's one real LLM call, read via
     * callChat. On the tool-loop path (fileTools/webTools configured), every
     * tool-bearing round trip stays non-streaming — callChatStructured isn't a
     * streaming call for either backend — but once the model stops calling tools,
     * one extra callChat request re-asks for that same final answer as a real
     * streamed completion, *only when `onToken` is supplied* (so a caller who
     * doesn't listen never pays for it). ClaudeCliLLMClient's callChat isn't real
     * per-token streaming either way (it yields the whole reply as one chunk) —
     * this only reads token-by-token on the proxy backend.
     */
    onToken?: (token: string) => void;
    /**
     * Called once per tool call as it happens, with a human-readable summary — the "what
     * step is the assistant on right now" signal, distinct from onTrace's name/status-only
     * telemetry. Fires for every backend: the proxy backend's tool loop reports each call it
     * dispatches directly; the claude-cli backend reports calls its own agentic loop makes
     * autonomously inside a single subprocess call, via ChatOptions.onToolStep (see
     * ClaudeCliLLMClient).
     */
    onToolStep?: (step: AssistantToolStep) => void;
    /**
     * **Benchmark harness only.** Wraps the one-loop
     * proposer so its first `failIterations` harness iterations report a failed execution
     * and `seedFailures` recurring same-class records are seeded into the run's
     * `failureDiagnostics` — enough to trip `cannotMakeProgress()` on iteration 1 and
     * exercise the Trajectory Supervisor's stall edge inside a single benchmark turn. Never
     * set by a real caller; ignored unless the one-loop proposer path is active.
     */
    __benchmarkInjectedFailure?: {
        failIterations: number;
        seedFailures: number;
        onInjected?: () => void;
        symptom?: string;
    };
    /**
     * Phase 4 of plans/hierarchical_goal_tree_and_steering_plan.html (R1/R4) — the session-scoped
     * LiveSteeringChannel a caller (cli.ts/App.tsx, Phase 3) built for mid-task steering. When
     * present, `turn()` wraps it in a scope×urgency-classifying UpdateChannel
     * (goal-graph-reconcile.ts) and threads it into harnessBridge.run() so queued messages are
     * absorbed at the harness's own checkCallerUpdates iteration boundary instead of waiting for
     * the turn to finish. PersonalAssistant never reads goalGraphMode itself (same convention as
     * oneLoopMode/askMode/planMode) — the caller decides whether to pass this at all; when absent,
     * behavior is exactly today's (INV-43). Whatever this turn's harness run doesn't get around to
     * classifying (it ends before the queue drains, or never calls harnessBridge.run() at all — a
     * trivial turn) is pushed back onto this same channel in a `finally`, so the caller's own
     * post-turn fallback drain (built in Phase 3) still picks it up — R4's "never silently drop"
     * holds either way.
     */
    steeringChannel?: LiveSteeringChannel;
}
export interface PersonalAssistantOptions {
    llmClient: ILLMClient;
    model?: string;
    /**
     * The already-resolved project label a project-scoped fact gets tagged with and filtered
     * against — see UserFact.project's doc comment. Callers resolve `config.activeProject ??
     * workspaceRoot` themselves (cli.ts's buildAssistant) before passing it in; PersonalAssistant
     * doesn't know about workspaceRoot itself (it's a per-tool option, not assistant-wide — see
     * fileTools/shellTools/actionTools). Undefined/empty leaves every fact unscoped, matching a
     * fresh install with no workspace concept at all.
     */
    activeProject?: string;
    /** M1: character budget for the facts block under `AUDIT_MEMORY_BUDGETED_RENDER` — see config.ts's `memoryBudgetChars`. */
    memoryBudgetChars?: number;
    /** M6: where model-originated memory writes may land (`auto`/`staged`/`user_only`, default `staged`) — see memory-governance.ts. Changeable live via `setMemoryWriteMode`. */
    memoryWriteMode?: MemoryWriteMode;
    /**
     * M5: run memory consolidation in the background on `/new` (`clearSession`). Off unless the host sets it: the CLI does; chat-ui must not until M6's pending-queue controls exist (D1 stages every proposal, and a browser user could not review one). Still gated by `AUDIT_MEMORY_CONSOLIDATION`.
     */
    consolidateOnNewSession?: boolean;
    /** Conversation transcript storage — defaults to an in-process Map, swap for IndexedDBAdapter in the browser. */
    memory?: MemoryAdapter;
    /** Learning-layer store — persist and pass the same instance back in across sessions to retain strategy weights. */
    experienceStore?: ExperienceStore;
    /** Stores an in-flight harness run's checkpoint so a crash/reload mid-turn can resume instead of losing the turn. */
    checkpointStore?: CheckpointStore;
    /**
     * Caps both the harness's plan-driven main loop (auto-raised there via
     * `Math.max(maxSteps, initialTasks.length)` so a decomposed plan is never starved) and the
     * ReAct-style tool loop's round-trips (AgentLoop.runToolLoop) — one shared per-turn step
     * budget rather than two independently-tuned constants. Defaults to 15: high enough that a
     * legitimate multi-query research task (e.g. "find primary schools near me", which can
     * easily take 5+ real search round-trips) doesn't get cut off mid-work, while still bounding
     * a stuck/looping model.
     */
    maxSteps?: number;
    /**
     * When set, `turn()` gives the model real read_file/list_directory/write_file
     * tools scoped to `workspaceRoot` instead of a single plain chat call. Absent
     * by default — behavior is byte-for-byte unchanged from before this option existed.
     * `write_file` never executes inline; it always stages a proposal and the turn
     * returns `needs_approval` with a `pendingWriteId`.
     */
    fileTools?: FileToolsContext;
    /**
     * When set, `turn()` also gives the model web_search/fetch_url tools, grounding replies in external content.
     * Absent by default — behavior is unchanged when unset. Results from these two tools are wrapped in
     * `<untrusted_external_content>` before they reach the model (see trust-tagging.ts) — unlike file tools,
     * this is content the assistant does not vouch for.
     */
    webTools?: WebToolsContext;
    /**
     * When set, `turn()` gives the model a real run_shell_command tool scoped to `workspaceRoot`.
     * Every call is gated on approval, full stop — there is no "safe subset" the way `read_file` is
     * safe within `write_file`'s tool group (a shell command has no structural split between "reads"
     * and "mutates"). Once approved, the command's stdout+stderr is wrapped in
     * `<untrusted_external_content>` (same trust boundary as web_search/fetch_url — see
     * trust-tagging.ts) before it's saved into the transcript, since it can carry the same kind of
     * injection-shaped content a fetched web page can. Independent of `fileTools`/`webTools` so a
     * caller can enable file/web access without ever exposing shell.
     */
    shellTools?: ShellToolsContext;
    /**
     * When set, `turn()` gives the model real "effect" tools — today `send_email` — scoped to
     * `workspaceRoot` for staging. Every call is approval-gated exactly like `write_file` /
     * `run_shell_command`: the model can only propose a message, never deliver one. On approval,
     * `applyPendingAction` calls `sendEmail` (email.ts's Resend transport / email-smtp.ts's SMTP
     * transport — wired in by a Node caller, never imported here). Independent of
     * `fileTools`/`webTools`/`shellTools`. Absent by default — no `send_email` tool exists unless set.
     */
    actionTools?: ActionToolsContext;
    /** Stores reminders detected from "remind me"/"set a reminder"-shaped requests — defaults to an in-process store. See ReminderStore's `dueAt` doc: v1 stores raw text only, no time parsing, so `listDue()` won't return these yet. */
    reminderStore?: ReminderStore;
    /** Structured turn telemetry — turn/risk/triviality/harness-node/tool-call/escalation/error events. Purely additive instrumentation; no behavior change when unset. */
    onTrace?: (event: TraceEvent) => void;
    /**
     * Full message/tool content for live debugging — deliberately separate from `onTrace`
     * (which is name/status-only by design, safe to hand to an arbitrary sink; see its own doc
     * comment) since this one carries the actual conversation. Off by default: nothing is
     * logged anywhere unless a caller wires this in. See DebugLogEntry.
     */
    onDebugLog?: (entry: DebugLogEntry) => void;
    /**
     * Equivalent of Claude Code's own --dangerously-skip-permissions (see AssistantConfig's doc
     * comment in config.ts). When true, both the message-level risk gate and write_file/
     * run_shell_command's per-call staging resolve as if the user had already said yes, instead
     * of returning `needs_approval` — turn() auto-applies a staged action the same way a second
     * turn() call with `approved: true` would. The underlying sandboxing (path validation, SSRF
     * guard, shell env allowlist, output truncation, timeout) is never skipped — only the ask.
     * Off by default.
     */
    dangerouslySkipPermissions?: boolean;
    /**
     * Aielia Write (T13): when set, each writer message is read for reviewer comments, decisions and corrections to sources, the result is
     * stored per article through this port (not per session), and the open items of the active article are added to the system prompt
     * on every turn. Unset (every other caller) means none of this runs. See plans/aielia_write_article_model_plan.html, section 8.
     */
    writerChat?: WriterChatPort;
    /**
     * Opt-in session spend/turn-count ceilings — see spend-cap.ts. Undefined by default, same as
     * every other field here that changes behavior only when a caller sets it: no ceiling means
     * exactly today's unbounded behavior. Checked once per turn, before any LLM call that turn
     * would make (see turn()) — never mid-turn.
     */
    spendCap?: SpendCapConfig;
    /**
     * R2 of the internal plan — see one-loop-flag.ts's doc comment for the
     * full rollout rationale. 'disabled' (the default, for the whole R2-R4 rollout window): today's
     * behavior, byte-for-byte — HarnessBridge.run() always uses `() => draftReply` as its toolFn,
     * regardless of whether a caller happens to supply a proposer. 'enabled' lets a supplied
     * proposer (see HarnessRunParams.oneLoopProposer) actually be used. PersonalAssistant itself
     * never touches process.env — only cli.ts (or an equivalent surface entry point) is expected to
     * call resolveOneLoopMode(process.env) and pass the result here.
     */
    oneLoopMode?: OneLoopMode;
    /** AL8a — layer policy mode ('static' default = today's behaviour). Resolved by the surface via resolveLayerPolicyMode; PersonalAssistant never reads process.env for it. */
    layerPolicyMode?: LayerPolicyMode;
    /**
     * R7 (Tier 1.5) — next-step suggestions, one bounded LLM call each: after every full
     * (non-trivial, `ok`) turn, up to three options are attached to the result as `nextSteps` for
     * the front end to show under the reply; and when a GoalThread finishes its last task, its own
     * suggestions are persisted on the thread for `/goals`. Defaults to 'disabled' — like
     * oneLoopMode/askMode/planMode, the front end resolves the flag (cli.ts / App.tsx pass
     * `config.goalGraphSuggestMode`, which defaults to enabled), so a library or benchmark caller
     * that never asks for suggestions makes no extra call and sees no new field (INV-43).
     */
    goalGraphSuggestMode?: GoalGraphSuggestMode;
    /** Run the reply audit (reply-audit.ts) after each successful turn; defaults to the AIELIA_REPLY_AUDIT env gate (on). */
    replyAudit?: boolean;
    /**
     * Q2 of the internal plan — global-flag control point (tier 1 of
     * INV-29) for the ask-question mechanism. Undefined (the default) falls back to
     * `DEFAULT_ASK_MODE` ('disabled') — today's behavior, byte-for-byte: every escalation stays on
     * the plain `escalated`/`reply: null` path. Only cli.ts/chat-ui's App.tsx (or an equivalent
     * surface entry point) is expected to resolve this from ASSISTANT_ASK_MODE/
     * VITE_ASSISTANT_ASK_MODE and pass it down — PersonalAssistant itself never touches
     * process.env, mirroring oneLoopMode's own convention.
     */
    askMode?: AskMode;
    /**
     * P11 of the internal plan — see plan-mode-flag.ts's doc comment for
     * the full rollout rationale. 'legacy' (the default, for the whole rollout window): P3's
     * judgment-based auto-trigger below never fires, so `turn()` never auto-enters plan mode's
     * exclusive drafting+approval loop — today's behavior, byte-for-byte, for every real user turn.
     * 'gated' lets that auto-trigger run. PersonalAssistant itself never touches process.env — only
     * cli.ts/chat-ui's App.tsx (or an equivalent surface entry point) is expected to call
     * resolvePlanMode(process.env)/normalizePlanMode(import.meta.env...) and pass the result here.
     */
    planMode?: PlanRolloutMode;
    /**
     * AL3a — see ambiguity-guard-flag.ts. Absent/'disabled' (the default): routing is byte-identical to
     * before. 'enabled': a consequential turn whose request doesn't determine the action gets a
     * clarifying question instead of a staged guess. PersonalAssistant never reads process.env; the
     * surface entry point resolves ASSISTANT_AMBIGUITY_GUARD / `/config set ambiguityGuardMode`.
     */
    ambiguityGuardMode?: AmbiguityGuardMode;
}
/**
 * A light, everyday-use wrapper around HarnessRuntime: one harness run per chat turn,
 * one real LLM call per turn (skipped entirely while a HIGH-risk action awaits approval).
 * Conversation history lives beside the harness run (in `memory`), not inside it — each
 * turn's WorldModel/TaskGraph/etc. are scratch state for that single turn, same as the
 * rest of the 11-layer runtime; only the transcript, the ExperienceStore, and (while a
 * turn is actually in flight) a HarnessRunState checkpoint persist.
 *
 * Phase 4d of the architecture remediation plan split this class's internals into 8
 * single-purpose collaborators (MemoryService, AssistantSession, AgentLoop,
 * ActionApprovalService, PlanService, TurnInterpreter, HarnessBridge, ResponseService), each
 * constructed once here and wired together. This class itself is now a thin facade + sequencer:
 * its public constructor signature and every public method below are unchanged, so every
 * existing caller (cli.ts, chat-ui's App.tsx, assistant.test.ts's ~89 `new PersonalAssistant(...)`
 * call sites) keeps working with zero call-site changes.
 */
export declare class PersonalAssistant {
    private readonly llmClient;
    private readonly abortGate;
    /** A stopped turn whose in-flight model call has not come back yet. Its gate stays armed until it settles, so it cannot write the transcript late. */
    private stoppedWork?;
    private model?;
    private activeProject?;
    private memoryBudgetChars?;
    private memoryWriteMode;
    private consolidateOnNewSession;
    private readonly memory;
    private readonly webTools?;
    private readonly onTrace?;
    private readonly onDebugLog?;
    private readonly dangerouslySkipPermissions;
    private readonly writerChat;
    /** Whenever any of fileTools/webTools/shellTools is configured, `turn()` routes through AgentLoop instead of a single plain chat call — computed once here since it never changes for the lifetime of an instance. */
    private readonly toolLoopWillRun;
    /** R3 of the internal plan — mirrors the same flag HarnessBridge was given at construction, kept here too so runTurn can decide whether to defer the tool loop into a harness-driven proposer instead of precomputing draftReply. See PersonalAssistantOptions.oneLoopMode's doc comment. */
    private readonly oneLoopMode;
    private readonly layerPolicyMode;
    /** Q2 — global-flag tier of the ask-question mechanism's three-tier INV-29 resolution. See PersonalAssistantOptions.askMode's doc comment. */
    private readonly askMode;
    /** P11 — gates whether P3's auto-trigger below can ever enter plan mode for real traffic. See PersonalAssistantOptions.planMode's doc comment. */
    private readonly planMode;
    /**
     * Scratch slot for which proposer drove the most recent runTurn — read by `turn()` to stamp
     * AssistantTurnResult.proposerKind, and emitted as a 'proposer_selected' trace event from
     * runTurn itself. A single mutable field is safe because `turn()` is awaited end to end (turns
     * never overlap within one instance). See AssistantTurnResult.proposerKind and
     * the internal plan phase B1.
     */
    private lastProposerKind;
    /** See PersonalAssistantOptions.goalGraphSuggestMode. */
    private readonly goalGraphSuggestMode;
    private readonly memoryService;
    /** M4 post-turn cross-turn memory reviewer; inert unless `AUDIT_MEMORY_REVIEWER` is on. */
    private readonly memoryReviewer;
    private readonly session;
    private readonly agentLoop;
    private readonly actionApproval;
    /** Set when the reply was already logged by the reply-ready hook this turn (see AssistantSession.replyReadyHook). */
    private replyLoggedEarly;
    /** Automatic correction retries still allowed for the current user message; resumed (approval) turns share it so a retry cannot chain. */
    private auditRetryBudget;
    /** The session of the turn in progress, for log lines written by code that has no session of its own (the side-call retry note). */
    private lastSessionId;
    /** The last real (not fail-safe) risk classification of a user message, per session, for the audit retry that may correct its reply. */
    private readonly lastClassifiedBySession;
    /** Files, directories and pages each session's turns have read (tool and target, oldest first, capped): the reply audit needs reads from EARLIER turns too, or a correct answer about a file read last turn looks like an unverified outside fact (V1). In memory only; cleared with the session. */
    private readonly sourcesReadBySession;
    /** Index into the action list where the current user message's actions start; an approval resume is a separate turn() call but the same user message. */
    private userMessageActionsStart;
    private readonly replyAuditOn;
    private readonly planService;
    private readonly planApproval;
    private readonly planDrafting;
    private readonly planSketch;
    private readonly turnInterpreter;
    private readonly harnessBridge;
    private readonly responseService;
    private readonly askClarification;
    constructor(options: PersonalAssistantOptions);
    /**
     * Preferred entry point in a browser: defaults transcript, learning, and
     * checkpoint storage to their IndexedDB/Dexie-backed implementations so all
     * three survive a page reload, instead of the in-process defaults the plain
     * constructor uses. Falls back to the same in-memory defaults as `new
     * PersonalAssistant(...)` outside a browser (e.g. the CLI).
     */
    static create(options: PersonalAssistantOptions): Promise<PersonalAssistant>;
    /**
     * The bigger picture both next-step proposers get (see next-step-context.ts): earlier
     * conversation, the steps taken this turn, and every goal thread the session tracks. Best-effort —
     * any read failure just yields no extra context, never a failed turn. At turn end the focus
     * thread is the one the graph currently marks active; for a thread that just finished it is that
     * thread.
     */
    private nextStepContext;
    /** Logs a message that arrived while a turn was running, at receipt time (its `user_message` is only logged when it is processed). */
    logQueuedMessage(sessionId: string, message: string): void;
    /**
     * Thin wrapper around runTurn(): emits turn_start/turn_end/error trace events
     * around the actual logic, so every one of runTurn's return paths gets a
     * matching turn_end without instrumenting each one individually.
     */
    turn(userMessage: string, options?: TurnOptions): Promise<AssistantTurnResult>;
    /**
     * M4: after a delivered, ordinary interactive reply, counts the turn and (every N turns without a memory write) starts the
     * cross-turn memory review in the background. Not awaited: the reply is already on its way. Skipped for non-interactive and
     * batch-research turns, and when the layer policy switched the layer off. Its spend is recorded through the same
     * `recordSpend` path as the turn's own, so `/cost` and the spend cap include it.
     */
    private maybeStartMemoryReview;
    /** Resolves when any in-flight background memory review has finished (a host about to exit, or a test). */
    awaitMemoryReview(): Promise<void>;
    /** Persisted alongside transcript/facts/plan — survives a process restart, same as everything else keyed by sessionId, so the ceiling is genuinely cross-session, not just cross-turn within one process lifetime. */
    getSpendState(sessionId: string): Promise<SpendState>;
    /** The session's conversation transcript, oldest first — same array `turn()` reads/appends to. Used by `/export`. */
    getTranscript(sessionId: string): Promise<ChatMessage[]>;
    /**
     * Records a message-level risk-gate decline as a resolved, paired exchange, once the caller
     * (cli.ts) knows the final answer was "no". See AssistantSession.recordDeclinedRequest's doc
     * comment for the full reasoning.
     */
    recordDeclinedRequest(sessionId: string, userMessage: string, reason: string): Promise<void>;
    /** Ends the current conversation — see AssistantSession.clearSession's doc comment for exactly what is and isn't cleared. */
    /** Remembers what a turn read (tool and target) for the reply audit of later turns; oldest entries drop first. */
    private noteSourcesRead;
    clearSession(sessionId: string): Promise<void>;
    /** M5: propose memory consolidation (applies nothing). `manual` forces the model pass past the cost gate. Usage is recorded against the spend state like any other call. */
    proposeMemoryConsolidation(sessionId: string, manual?: boolean): Promise<Awaited<ReturnType<MemoryService['runConsolidation']>>>;
    /** The consolidator MemoryService.consolidate() runs for `/memory consolidate` (chat-ui's button): runs the proposal pass now and reports; applying anything is still the user's accept. */
    private runRegisteredConsolidation;
    /** M5: staged proposals awaiting the user. */
    memoryProposals(): Promise<ConsolidationProposal[]>;
    /** M5: `/memory consolidate accept <n>` (1-based). */
    acceptMemoryProposal(selector: string, sessionId: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** M5: `/memory consolidate dismiss <n>` (1-based). */
    dismissMemoryProposal(selector: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** How many entries at the head of `listArchivedFacts()` were set aside by staged forgetting (M5) and can be restored; the rest were replaced by a newer statement. */
    restorableArchiveCount(): Promise<number>;
    /** `/memory archive restore <n>` (1-based, over the same numbered listing as `/memory archive`). */
    restoreArchivedMemory(selector: string, sessionId: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /**
     * M3 session edge: with AUDIT_EPISODIC_DIGEST on, writes the conversation's handoff digest (one bounded call, fail-open)
     * for the current conversation (the rolling digest is refreshed, not duplicated, if the same conversation is digested again). `clearSession` (/new) calls it, then ends the conversation's digest identity; the CLI calls it on exit; never from inside a turn.
     * With the flag off this does nothing, so the old behaviour is untouched.
     */
    endSession(sessionId: string): Promise<void>;
    /** Stored episodic digests (newest first), for the memory panel and `/memory`; read-only. */
    listSessionDigests(): Promise<SessionDigest[]>;
    /** Which optional memory writers are switched on for this process (their `AUDIT_*` flags): hosts use it to show or hide the matching controls. A writer that is off makes no model call and no write. */
    memoryWriterFlags(): {
        reviewer: boolean;
        consolidation: boolean;
        digest: boolean;
    };
    /** M3 (D4): `/memory forget digest <id>` or all digests when `id` is omitted; returns how many were removed. */
    forgetDigests(id?: string): Promise<number>;
    /**
     * P1 of the internal plan — explicit entry point into plan mode's
     * exclusive drafting state. No production caller yet: P3 will later set this automatically from
     * a judgment-based trigger ahead of TurnInterpreter's classification. Until then this is reached
     * only by a caller (a future `/plan` CLI command, or a test) that wants to exercise the drafting
     * loop directly. Once active, every `turn()` call for this session routes to
     * `PlanDraftingService` instead of the normal pipeline until the user says an explicit
     * cancel/abort phrase.
     */
    enterPlanMode(sessionId: string): Promise<{
        active: boolean;
        draftId: string;
    }>;
    /**
     * P7 of the internal plan — the raw current `PlanRecord` for this
     * session, regardless of `mode`, so a caller (chat-ui's persistent banner, the CLI's `/plan
     * show`) can display live drafting/awaiting-approval state independent of any single turn's
     * own result (a `needs_plan_approval` result only carries a snapshot at the moment it's
     * staged; a plain `status: 'ok'` drafting reply doesn't carry `rationale`/`reviewNotes` at
     * all). Returns `null` when no plan record exists for this session yet.
     */
    getPlanState(sessionId: string): Promise<PlanRecord | null>;
    /**
     * Phase 7 of plans/hierarchical_goal_tree_and_steering_plan.html (R5, "Visibility") — the shared
     * read surface behind the CLI's `/goals` and chat-ui's GoalsPanel, analogous to `searchTranscript`
     * above. A pure query over whatever Phases 4-5 already populate in this session's
     * `GoalGraphRecord`; never mints or mutates one. Returns the empty state for a session with no
     * goal graph yet, same "nothing to show" convention `getGoalGraphState` itself documents.
     */
    getGoalGraphState(sessionId: string): Promise<GoalGraphState>;
    /**
     * Read-only source for the plan graph view: the session's goal graph when it has threads, else its
     * plan record, else `null`. Never throws and never creates a record.
     */
    getPlanGraph(sessionId: string): Promise<PlanRecord | GoalGraphRecord | null>;
    /**
     * P9 of the internal plan — the lightweight plan-sketch delegate: a
     * cheaper "just go research and draft an approach" path than plan mode's durable task-graph
     * machinery (P0-P8), explicitly invoked (a CLI `/plan sketch <request>` command, a chat-ui
     * "Sketch a plan" action) rather than auto-triggered. Returns advice in the reply text — it
     * never creates a `PlanRecord`, never sets `planMode.active` (`enterPlanMode` above), never
     * stages anything for `PlanApprovalService`, and cannot execute a single task (INV-35). A real,
     * cost-incurring LLM call, so it still goes through the same session spend-cap check/record as
     * an ordinary `turn()` — just none of `turn()`'s classification/tool-loop/plan-mode machinery.
     */
    sketchPlan(sessionId: string, request: string): Promise<AssistantTurnResult>;
    /** Scoped recovery for a stuck harness checkpoint — see AssistantSession.clearCheckpoint's doc comment. */
    clearCheckpoint(sessionId: string): Promise<{
        cleared: boolean;
        stepsUsed?: number;
        currentNode?: string;
    }>;
    /** Read-only counterpart to clearCheckpoint — see AssistantSession.getCheckpointStatus's doc comment. */
    getCheckpointStatus(sessionId: string): Promise<{
        present: boolean;
        stepsUsed?: number;
        currentNode?: string;
        failedResumeAttempts: number;
    }>;
    /** Removes the most recent exchange from conversation history — see AssistantSession.undoLastTurn's doc comment. */
    undoLastTurn(sessionId: string): Promise<{
        undone: boolean;
    }>;
    /** Real filesystem effects still on record as revertible, newest first — see AssistantSession.listUndoLogEntries's doc comment. */
    listUndoLogEntries(): Promise<UndoLogEntry[]>;
    /** Stages a revert of undo-log entry `id` as its own approval-gated pending action — see AssistantSession.stageUndoAction's doc comment. */
    stageUndoAction(id: string): Promise<{
        status: 'staged';
        pendingActionId: string;
        reason: string;
    } | {
        status: 'error';
        message: string;
    }>;
    /** Read-only snapshot of what this session/assistant has learned — see MemoryService.getMemorySummary's doc comment. Used by `/memory`. */
    getMemorySummary(sessionId: string): Promise<MemorySummary>;
    /** Full, unbounded snapshot of everything learned so far — see MemoryService.exportMemory's doc comment. Used by `/memory export`. */
    exportMemory(sessionId: string): Promise<MemoryExport>;
    /**
     * `/memory confirm <n|category>` — `selector` is either a 1-based index into `/memory`'s
     * flat, display-order "Pending confirmation" listing, or one of FactCategory's names for a
     * bulk confirm. Phase 3 of the internal plan.
     * `conflictNotices` (if any) are advisory only — every confirmed fact is promoted regardless,
     * matching how every other contradiction check in this codebase never gates belief admission.
     */
    confirmPendingFact(selector: string): Promise<MemoryPendingOutcome>;
    /** `/memory reject <n|category>` — mirror of confirmPendingFact, see its doc comment for `selector`'s shape. */
    rejectPendingFact(selector: string): Promise<MemoryPendingOutcome>;
    /**
     * `/memory forget <n>` — `n` is a 1-based index into `/memory`'s "Facts I know" listing (durable
     * facts first, then session facts — the same order `getMemorySummary()` returns). Unlike
     * confirm/reject, there's no category form: a durable/session fact carries no `category` field,
     * only pending model-inferred guesses do. Hard-deletes rather than routing through
     * REJECTED_FACTS_KEY — see MemoryService.forgetFact's doc comment. By default the removal is recorded
     * in the audit log with the fact's text (so `/memory undo` can restore it); `erase` also scrubs that text.
     */
    forgetFact(selector: string, sessionId: string, erase?: boolean): Promise<MemoryPendingOutcome>;
    /** `/memory history` — the newest audit-log entries (M2). Empty unless `AUDIT_MEMORY_AUDIT_LOG` is on. */
    memoryHistory(limit?: number): Promise<AuditEntry[]>;
    /** `/memory history events [fact]` — transition events with reason and sources (`AUDIT_MEMORY_EVENTS`, default on). */
    memoryEvents(limit?: number, filter?: EventFilter): Promise<MemoryEvent[]>;
    /** `/memory undo <seq>` — restores the pre-image of one audit entry (M2). */
    undoMemoryChange(selector: string, sessionId: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** `/memory` governance mode (M6) — takes effect on the next write. */
    getMemoryWriteMode(): MemoryWriteMode;
    /** Live mode change (CLI `/config set` reloads the assistant; chat-ui calls this directly). Unknown values keep the default rather than widening write authority. */
    setMemoryWriteMode(mode: MemoryWriteMode | string): void;
    /** `/memory off` / `/memory on` — stop or resume all memory writes (facts, pending queue, digests, reviewer, consolidation) for this install. Existing data stays readable and removable. */
    setMemoryEnabled(enabled: boolean): Promise<void>;
    isMemoryEnabled(): Promise<boolean>;
    /** Store size vs budget, pending/audit counts, last consolidation, governance state — `/doctor` and the memory panel. Read-only. */
    getMemoryStatus(sessionId: string): Promise<MemoryStatus>;
    /** The facts the last turn's prompt actually contained, plus how many were left out — the "Why?" panel / `/why` line. Undefined before the first turn. */
    getLastMemoryInjection(): MemoryInjection | undefined;
    /** `/memory archive` — entries set aside by staged forgetting (restorable, first) then entries a keyed update replaced (newest first). */
    listArchivedFacts(): Promise<UserFact[]>;
    /** `/memory archive forget <n>` — permanently erases one archived entry and its history pre-images. */
    forgetArchivedFact(selector: string): Promise<MemoryPendingOutcome>;
    /** `/memory consolidate` — runs the registered consolidator (M5). Until M5 registers one this reports `unavailable`. */
    consolidateMemory(sessionId: string): Promise<ConsolidationOutcome | {
        status: 'unavailable' | 'blocked';
        message: string;
    }>;
    /** M5 hook: lets the consolidation phase plug in without touching the surfaces. */
    registerMemoryConsolidator(fn: Parameters<MemoryService['registerConsolidator']>[0]): void;
    /** Ranked search over the per-message index — see AssistantSession.searchTranscript's doc comment. Used by `/search`. */
    searchTranscript(query: string, topK?: number): Promise<TranscriptSearchHit[]>;
    /** Changes the model used by every subsequent `turn()` call, mid-session — no reconstruction needed. Used by `/model`. Every collaborator constructed above reads this field through a getter closure, never a captured string, so this takes effect for all of them immediately. */
    setModel(model: string | undefined): void;
    /** The project label new project-scoped facts are tagged with and existing ones are filtered against this session — see UserFact.project's doc comment. Empty string when none is set (cli.ts's buildAssistant always resolves one from workspaceRoot, but a bare `new PersonalAssistant()` with no `activeProject` option should read as "no project concept" rather than `undefined`). */
    getActiveProject(): string;
    /** Mid-session override for `activeProject`, mirroring setModel — takes effect on the very next turn via the same getter-closure MemoryService already reads through. Used by `/project <name>` outside the CLI's own /config-set-and-reload path (e.g. a future non-CLI embedder). */
    setActiveProject(project: string | undefined): void;
    /**
     * The sequencer: constructs no state of its own beyond what a single turn needs
     * (transcript/facts/system prompt, the turn-scoped usage accumulator), and otherwise just
     * calls each collaborator in the same order the pre-split code ran their logic inline, wiring
     * each one's output into the next. See turn-interpreter.ts/agent-loop.ts/harness-bridge.ts/
     * response-service.ts for where the real control-flow subtlety (the batch-research path, the
     * plan-cancel bypass, the triviality fast path) actually lives now.
     */
    private runTurn;
    /** What ActionApprovalService needs to continue a paused tool loop after an approval: the live callbacks, and how a further pause becomes a turn result. */
    private loopResumeOptions;
    /**
     * Shared by the flag-OFF flat/batch tool loop's own needs_approval/escalated ToolLoopResult and
     * the flag-ON harness-driven proposer's equivalent OneLoopPause (R3 of
     * the internal plan, see runTurn's two call sites) — "the model wants
     * to write/run/send something" or "the tool loop gave up" means the same thing to the caller
     * regardless of which loop discovered it.
     */
    private buildToolLoopPauseResult;
}
