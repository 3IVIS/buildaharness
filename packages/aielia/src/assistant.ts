import {
  EscalationHalt,
  InMemoryExperienceStore,
  resolveAskMode as resolveEffectiveAskMode,
  type ExperienceStore,
  type CheckpointStore,
  type ToolExecutorContext,
  type AskResponse,
} from '@buildaharness/harness'
import {
  InMemoryAdapter,
  IndexedDBAdapter,
  DexieExperienceStore,
  InMemoryReminderStore,
  type MemoryAdapter,
  type ILLMClient,
  type ChatMessage,
  type ReminderStore,
  type TokenUsage,
} from '@buildaharness/runtime'
import { detectHomogeneousBatchList } from './batch-list-detector.js'
import { classifyAndTraceExecutionMode } from './execution-mode.js'
import { evaluateTurnPolicy } from './turn-policy.js'
import type { FileToolsContext } from './file-tools.js'
import type { UndoLogEntry } from './action-snapshot.js'
import type { WebToolsContext } from './web-tools.js'
import type { ShellToolsContext } from './shell-tools.js'
import type { ActionToolsContext } from './action-tools.js'
import type { SpendCapConfig, SpendState } from './spend-cap.js'
import { SYSTEM_PROMPT } from './system-prompt.js'
import type { TraceEvent } from './trace-events.js'
import type { AssistantToolStep } from './tool-step.js'

import { MemoryService, buildTurnFacts, type MemorySummary, type MemoryExport, type PendingFact } from './memory-service.js'
import type { UserFact } from './fact-extraction.js'
import { AssistantSession, type IndexedMessage, type TranscriptSearchHit } from './assistant-session.js'
import { AgentLoop, OneLoopPause, type BatchBudgetState, type BatchBudgetTrace, type ToolLoopResult, trimmedAverage, nextItemBudget } from './agent-loop.js'
import type { TurnIntentClassification, FactCategory } from './turn-intent-classifier.js'
import { ActionApprovalService } from './action-approval-service.js'
import { PlanService } from './plan-service.js'
import { PlanDraftingService } from './plan-drafting-service.js'
import { PlanApprovalService, type PlanDecision, type PlanApprovalEdits } from './plan-approval-service.js'
import { PlanSketchService } from './plan-sketch-service.js'
import type { PlanRecord } from './plan-store.js'
import { TurnInterpreter } from './turn-interpreter.js'
import { HarnessBridge } from './harness-bridge.js'
import { wrapProposerWithInjectedFailure } from './benchmark-injected-failure.js'
import { DEFAULT_ONE_LOOP_MODE, type OneLoopMode } from './one-loop-flag.js'
import { DEFAULT_ASK_MODE, type AskMode } from './ask-mode-flag.js'
import { DEFAULT_PLAN_MODE, type PlanRolloutMode } from './plan-mode-flag.js'
import { AskClarificationService } from './ask-clarification-service.js'
import { ResponseService } from './response-service.js'
import { createSteeringReconcileChannel } from './goal-graph-reconcile.js'
import { loadGoalGraphRecord, saveGoalGraphRecord, createEmptyGoalGraphRecord } from './goal-graph-store.js'
import { proposeNextSteps, proposeTurnNextSteps } from './next-step-proposer.js'
import { buildNextStepContext, type NextStepContext } from './next-step-context.js'
import type { GoalGraphSuggestMode } from './goal-graph-suggest-flag.js'
import { selectActiveThread } from './goal-thread-scheduler.js'
import { resolveTurnGoalThread } from './goal-thread-identity.js'
import { getGoalGraphState, type GoalGraphState } from './goal-graph-service.js'
import type { LiveSteeringChannel } from './live-steering-channel.js'
import type { AssistantSource } from './assistant-source.js'
import type { DebugLogEntry } from './debug-log.js'
import type { AssistantTrace, AssistantTurnResult, AssistantProgress, ProposerKind } from './assistant-types.js'
import { resolveSupervisorEnabled } from './supervisor-flag.js'

// Re-exported for full backward compatibility — every one of these used to be defined directly
// in this file; they now live in the module that owns their logic (see each module's own doc
// comment), and this file re-exports them under their original names so existing imports from
// './assistant.js' (index.ts, cli.ts, cli-session.ts, assistant.test.ts) keep working unchanged.
export type { MemorySummary, MemoryExport, PendingFact } from './memory-service.js'
export type { FactCategory } from './turn-intent-classifier.js'
export type { IndexedMessage, TranscriptSearchHit } from './assistant-session.js'
export type { GoalGraphState, GoalThreadView, GoalThreadVisibility, GoalTaskSummary } from './goal-graph-service.js'
export type { BatchBudgetState } from './agent-loop.js'
export { trimmedAverage, nextItemBudget } from './agent-loop.js'
export type { AssistantSource } from './assistant-source.js'
export type { DebugLogEntry } from './debug-log.js'
export type { AssistantTrace, AssistantTurnResult, AssistantProgress, ProposerKind } from './assistant-types.js'
export type { PlanDecision, PlanApprovalEdits } from './plan-approval-service.js'
export type { PlanMode } from './plan-store.js'

const isBrowser = (): boolean => typeof indexedDB !== 'undefined'

/** Result of `/memory confirm`/`/memory reject` (single index or bulk category) — see PersonalAssistant.confirmPendingFact/rejectPendingFact. */
export type MemoryPendingOutcome =
  | { ok: true; facts: UserFact[]; conflictNotices: string[] }
  | { ok: false; error: string }

const FACT_CATEGORIES: FactCategory[] = ['identity', 'health', 'preference', 'location', 'occupation', 'relationships', 'project', 'other']

/** `selector` matches a FactCategory name (case-insensitive) — used by confirmPendingFact/rejectPendingFact to distinguish `/memory confirm health` from `/memory confirm 3`. */
function asFactCategory(selector: string): FactCategory | undefined {
  const normalized = selector.trim().toLowerCase()
  return FACT_CATEGORIES.find((c) => c === normalized)
}

/** `/memory`'s pending listing is 1-based for the user; MemoryService's confirm/reject take a 0-based index. Returns undefined for anything that isn't a positive integer. */
function parsePendingIndex(selector: string): number | undefined {
  const n = Number.parseInt(selector.trim(), 10)
  return Number.isInteger(n) && n >= 1 ? n - 1 : undefined
}

export interface TurnOptions {
  sessionId?: string
  approved?: boolean
  pendingActionId?: string
  /**
   * Q2 of the internal plan — resolves a staged `needs_clarification`
   * result (see AssistantTurnResult.pendingClarificationId) with the user's answer. Mirrors
   * `pendingActionId`/`approved`'s own "resolved by ID, never re-derived" shape:
   * `clarificationAnswer` must answer exactly the questions that were staged, validated
   * server-side (INV-28) regardless of what the client already checked.
   */
  pendingClarificationId?: string
  clarificationAnswer?: AskResponse
  /**
   * P2 of the internal plan — resolves a staged `needs_plan_approval`
   * result (see AssistantTurnResult.planApprovalId) with the user's decision. Mirrors
   * `pendingActionId`/`approved`'s "resolved by ID, never re-derived" shape: what gets
   * approved/declined is exactly the plan that was staged, never re-drafted.
   */
  planApprovalId?: string
  /** `'approve'`/`'approve_with_edits'`/`'decline'` — required to resolve `planApprovalId`; omitting it leaves the plan `awaiting_approval` (fail closed), same as an unanswered clarification. */
  planDecision?: PlanDecision
  /** Only meaningful with `planDecision: 'approve_with_edits'` — cancels/edits applied before the plan is activated. */
  planEdits?: PlanApprovalEdits
  /**
   * Per-session override — tier 2 of Q1's three-tier INV-29 resolution. `'disabled'` forces
   * plain free-text-fallback escalations for this turn even when the global `askMode` config is
   * `'enabled'`. Absent/`'enabled'` defers to the global flag. Never widens the global flag: an
   * override can only turn structured questions off relative to it, never on when the global
   * flag is off.
   */
  askMode?: AskMode
  onProgress?: (progress: AssistantProgress) => void
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
  onToken?: (token: string) => void
  /**
   * Called once per tool call as it happens, with a human-readable summary — the "what
   * step is the assistant on right now" signal, distinct from onTrace's name/status-only
   * telemetry. Fires for every backend: the proxy backend's tool loop reports each call it
   * dispatches directly; the claude-cli backend reports calls its own agentic loop makes
   * autonomously inside a single subprocess call, via ChatOptions.onToolStep (see
   * ClaudeCliLLMClient).
   */
  onToolStep?: (step: AssistantToolStep) => void
  /**
   * **Eval harness only** (`packages/aielia/eval/`). Wraps the one-loop
   * proposer so its first `failIterations` harness iterations report a failed execution
   * and `seedFailures` recurring same-class records are seeded into the run's
   * `failureDiagnostics` — enough to trip `cannotMakeProgress()` on iteration 1 and
   * exercise the Trajectory Supervisor's stall edge inside a single benchmark turn. Never
   * set by a real caller; ignored unless the one-loop proposer path is active.
   */
  __benchmarkInjectedFailure?: { failIterations: number; seedFailures: number; onInjected?: () => void }
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
  steeringChannel?: LiveSteeringChannel
}

export interface PersonalAssistantOptions {
  llmClient: ILLMClient
  model?: string
  /**
   * The already-resolved project label a project-scoped fact gets tagged with and filtered
   * against — see UserFact.project's doc comment. Callers resolve `config.activeProject ??
   * workspaceRoot` themselves (cli.ts's buildAssistant) before passing it in; PersonalAssistant
   * doesn't know about workspaceRoot itself (it's a per-tool option, not assistant-wide — see
   * fileTools/shellTools/actionTools). Undefined/empty leaves every fact unscoped, matching a
   * fresh install with no workspace concept at all.
   */
  activeProject?: string
  /** Conversation transcript storage — defaults to an in-process Map, swap for IndexedDBAdapter in the browser. */
  memory?: MemoryAdapter
  /** Learning-layer store — persist and pass the same instance back in across sessions to retain strategy weights. */
  experienceStore?: ExperienceStore
  /** Stores an in-flight harness run's checkpoint so a crash/reload mid-turn can resume instead of losing the turn. */
  checkpointStore?: CheckpointStore
  /**
   * Caps both the harness's plan-driven main loop (auto-raised there via
   * `Math.max(maxSteps, initialTasks.length)` so a decomposed plan is never starved) and the
   * ReAct-style tool loop's round-trips (AgentLoop.runToolLoop) — one shared per-turn step
   * budget rather than two independently-tuned constants. Defaults to 15: high enough that a
   * legitimate multi-query research task (e.g. "find primary schools near me", which can
   * easily take 5+ real search round-trips) doesn't get cut off mid-work, while still bounding
   * a stuck/looping model.
   */
  maxSteps?: number
  /**
   * When set, `turn()` gives the model real read_file/list_directory/write_file
   * tools scoped to `workspaceRoot` instead of a single plain chat call. Absent
   * by default — behavior is byte-for-byte unchanged from before this option existed.
   * `write_file` never executes inline; it always stages a proposal and the turn
   * returns `needs_approval` with a `pendingWriteId`.
   */
  fileTools?: FileToolsContext
  /**
   * When set, `turn()` also gives the model web_search/fetch_url tools, grounding replies in external content.
   * Absent by default — behavior is unchanged when unset. Results from these two tools are wrapped in
   * `<untrusted_external_content>` before they reach the model (see trust-tagging.ts) — unlike file tools,
   * this is content the assistant does not vouch for.
   */
  webTools?: WebToolsContext
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
  shellTools?: ShellToolsContext
  /**
   * When set, `turn()` gives the model real "effect" tools — today `send_email` — scoped to
   * `workspaceRoot` for staging. Every call is approval-gated exactly like `write_file` /
   * `run_shell_command`: the model can only propose a message, never deliver one. On approval,
   * `applyPendingAction` calls `sendEmail` (email.ts's Resend transport / email-smtp.ts's SMTP
   * transport — wired in by a Node caller, never imported here). Independent of
   * `fileTools`/`webTools`/`shellTools`. Absent by default — no `send_email` tool exists unless set.
   */
  actionTools?: ActionToolsContext
  /** Stores reminders detected from "remind me"/"set a reminder"-shaped requests — defaults to an in-process store. See ReminderStore's `dueAt` doc: v1 stores raw text only, no time parsing, so `listDue()` won't return these yet. */
  reminderStore?: ReminderStore
  /** Structured turn telemetry — turn/risk/triviality/harness-node/tool-call/escalation/error events. Purely additive instrumentation; no behavior change when unset. */
  onTrace?: (event: TraceEvent) => void
  /**
   * Full message/tool content for live debugging — deliberately separate from `onTrace`
   * (which is name/status-only by design, safe to hand to an arbitrary sink; see its own doc
   * comment) since this one carries the actual conversation. Off by default: nothing is
   * logged anywhere unless a caller wires this in. See DebugLogEntry.
   */
  onDebugLog?: (entry: DebugLogEntry) => void
  /**
   * Equivalent of Claude Code's own --dangerously-skip-permissions (see AssistantConfig's doc
   * comment in config.ts). When true, both the message-level risk gate and write_file/
   * run_shell_command's per-call staging resolve as if the user had already said yes, instead
   * of returning `needs_approval` — turn() auto-applies a staged action the same way a second
   * turn() call with `approved: true` would. The underlying sandboxing (path validation, SSRF
   * guard, shell env allowlist, output truncation, timeout) is never skipped — only the ask.
   * Off by default.
   */
  dangerouslySkipPermissions?: boolean
  /**
   * Opt-in session spend/turn-count ceilings — see spend-cap.ts. Undefined by default, same as
   * every other field here that changes behavior only when a caller sets it: no ceiling means
   * exactly today's unbounded behavior. Checked once per turn, before any LLM call that turn
   * would make (see turn()) — never mid-turn.
   */
  spendCap?: SpendCapConfig
  /**
   * R2 of the internal plan — see one-loop-flag.ts's doc comment for the
   * full rollout rationale. 'disabled' (the default, for the whole R2-R4 rollout window): today's
   * behavior, byte-for-byte — HarnessBridge.run() always uses `() => draftReply` as its toolFn,
   * regardless of whether a caller happens to supply a proposer. 'enabled' lets a supplied
   * proposer (see HarnessRunParams.oneLoopProposer) actually be used. PersonalAssistant itself
   * never touches process.env — only cli.ts (or an equivalent surface entry point) is expected to
   * call resolveOneLoopMode(process.env) and pass the result here.
   */
  oneLoopMode?: OneLoopMode
  /**
   * R7 (Tier 1.5) — next-step suggestions, one bounded LLM call each: after every full
   * (non-trivial, `ok`) turn, up to three options are attached to the result as `nextSteps` for
   * the front end to show under the reply; and when a GoalThread finishes its last task, its own
   * suggestions are persisted on the thread for `/goals`. Defaults to 'disabled' — like
   * oneLoopMode/askMode/planMode, the front end resolves the flag (cli.ts / App.tsx pass
   * `config.goalGraphSuggestMode`, which defaults to enabled), so a library or benchmark caller
   * that never asks for suggestions makes no extra call and sees no new field (INV-43).
   */
  goalGraphSuggestMode?: GoalGraphSuggestMode
  /**
   * Q2 of the internal plan — global-flag control point (tier 1 of
   * INV-29) for the ask-question mechanism. Undefined (the default) falls back to
   * `DEFAULT_ASK_MODE` ('disabled') — today's behavior, byte-for-byte: every escalation stays on
   * the plain `escalated`/`reply: null` path. Only cli.ts/chat-ui's App.tsx (or an equivalent
   * surface entry point) is expected to resolve this from ASSISTANT_ASK_MODE/
   * VITE_ASSISTANT_ASK_MODE and pass it down — PersonalAssistant itself never touches
   * process.env, mirroring oneLoopMode's own convention.
   */
  askMode?: AskMode
  /**
   * P11 of the internal plan — see plan-mode-flag.ts's doc comment for
   * the full rollout rationale. 'legacy' (the default, for the whole rollout window): P3's
   * judgment-based auto-trigger below never fires, so `turn()` never auto-enters plan mode's
   * exclusive drafting+approval loop — today's behavior, byte-for-byte, for every real user turn.
   * 'gated' lets that auto-trigger run. PersonalAssistant itself never touches process.env — only
   * cli.ts/chat-ui's App.tsx (or an equivalent surface entry point) is expected to call
   * resolvePlanMode(process.env)/normalizePlanMode(import.meta.env...) and pass the result here.
   */
  planMode?: PlanRolloutMode
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
export class PersonalAssistant {
  private readonly llmClient: ILLMClient
  private model?: string
  private activeProject?: string
  private readonly memory: MemoryAdapter
  private readonly webTools?: WebToolsContext
  private readonly onTrace?: (event: TraceEvent) => void
  private readonly onDebugLog?: (entry: DebugLogEntry) => void
  private readonly dangerouslySkipPermissions: boolean
  /** Whenever any of fileTools/webTools/shellTools is configured, `turn()` routes through AgentLoop instead of a single plain chat call — computed once here since it never changes for the lifetime of an instance. */
  private readonly toolLoopWillRun: boolean
  /** R3 of the internal plan — mirrors the same flag HarnessBridge was given at construction, kept here too so runTurn can decide whether to defer the tool loop into a harness-driven proposer instead of precomputing draftReply. See PersonalAssistantOptions.oneLoopMode's doc comment. */
  private readonly oneLoopMode: OneLoopMode
  /** Q2 — global-flag tier of the ask-question mechanism's three-tier INV-29 resolution. See PersonalAssistantOptions.askMode's doc comment. */
  private readonly askMode: AskMode
  /** P11 — gates whether P3's auto-trigger below can ever enter plan mode for real traffic. See PersonalAssistantOptions.planMode's doc comment. */
  private readonly planMode: PlanRolloutMode
  /**
   * Scratch slot for which proposer drove the most recent runTurn — read by `turn()` to stamp
   * AssistantTurnResult.proposerKind, and emitted as a 'proposer_selected' trace event from
   * runTurn itself. A single mutable field is safe because `turn()` is awaited end to end (turns
   * never overlap within one instance). See AssistantTurnResult.proposerKind and
   * the internal plan phase B1.
   */
  private lastProposerKind: ProposerKind = 'posthoc'
  /** See PersonalAssistantOptions.goalGraphSuggestMode. */
  private readonly goalGraphSuggestMode: GoalGraphSuggestMode

  private readonly memoryService: MemoryService
  private readonly session: AssistantSession
  private readonly agentLoop: AgentLoop
  private readonly actionApproval: ActionApprovalService
  private readonly planService: PlanService
  private readonly planApproval: PlanApprovalService
  private readonly planDrafting: PlanDraftingService
  private readonly planSketch: PlanSketchService
  private readonly turnInterpreter: TurnInterpreter
  private readonly harnessBridge: HarnessBridge
  private readonly responseService: ResponseService
  private readonly askClarification: AskClarificationService

  constructor(options: PersonalAssistantOptions) {
    this.llmClient = options.llmClient
    this.model = options.model
    this.activeProject = options.activeProject
    this.memory = options.memory ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant' })
    const experienceStore = options.experienceStore ?? new InMemoryExperienceStore()
    const checkpointStore = options.checkpointStore ?? new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant-checkpoints' })
    const maxSteps = options.maxSteps ?? 15
    const fileTools = options.fileTools
    this.webTools = options.webTools
    const shellTools = options.shellTools
    const actionTools = options.actionTools
    const reminderStore = options.reminderStore ?? new InMemoryReminderStore(new InMemoryAdapter({ scope: 'thread', namespace: 'personal-assistant-reminders' }))
    this.onTrace = options.onTrace
    this.onDebugLog = options.onDebugLog
    this.dangerouslySkipPermissions = options.dangerouslySkipPermissions ?? false
    const spendCap = options.spendCap
    this.toolLoopWillRun = Boolean(fileTools || this.webTools || shellTools || actionTools)
    this.oneLoopMode = options.oneLoopMode ?? DEFAULT_ONE_LOOP_MODE
    this.askMode = options.askMode ?? DEFAULT_ASK_MODE
    this.planMode = options.planMode ?? DEFAULT_PLAN_MODE

    // Threaded as a getter closure — never a captured string — into every collaborator that
    // reads the current model, so `setModel()` (the `/model` command) keeps working for all of
    // them mid-session instead of freezing whichever model was set at construction time.
    const model = (): string | undefined => this.model
    // Same getter-closure convention as `model` above — MemoryService reads this fresh on every
    // recordFacts()/loadFacts() call, so setActiveProject() takes effect on the very next turn.
    const currentProject = (): string => this.activeProject ?? ''

    this.memoryService = new MemoryService(this.memory, reminderStore, experienceStore, this.llmClient, model, currentProject)
    this.session = new AssistantSession(this.memory, checkpointStore, spendCap, model, fileTools, shellTools, actionTools)
    this.agentLoop = new AgentLoop(
      this.memory,
      this.llmClient,
      model,
      fileTools,
      this.webTools,
      shellTools,
      actionTools,
      reminderStore,
      maxSteps,
      this.onTrace,
      this.onDebugLog,
    )
    // Plan mode's P5 file-backed persistence reuses AssistantSession's existing
    // write_file/run_shell_command workspace lookup rather than re-deriving fileTools/
    // shellTools/actionTools precedence a second time here — `undefined` on a surface with no
    // real filesystem (e.g. a browser tab), same as undoWorkspace()'s other callers.
    this.planService = new PlanService(this.memory, this.session.undoWorkspace())
    this.planApproval = new PlanApprovalService(this.planService, this.session, this.onTrace)
    this.planDrafting = new PlanDraftingService(this.planService, this.session, this.llmClient, model, this.planApproval, this.onTrace, this.agentLoop, this.memory)
    this.planSketch = new PlanSketchService(this.llmClient, model, this.onTrace, this.agentLoop)
    this.actionApproval = new ActionApprovalService(
      this.memory,
      this.llmClient,
      model,
      fileTools,
      shellTools,
      actionTools,
      this.session,
      this.agentLoop,
      this.onTrace,
      this.onDebugLog,
    )
    this.turnInterpreter = new TurnInterpreter(this.llmClient, model, this.planService, reminderStore)
    this.harnessBridge = new HarnessBridge(
      this.memory, experienceStore, checkpointStore, this.llmClient, model, maxSteps,
      this.planService, this.session, this.onTrace, this.oneLoopMode,
    )
    this.goalGraphSuggestMode = options.goalGraphSuggestMode ?? 'disabled'
    const goalGraphSuggestMode = this.goalGraphSuggestMode
    this.responseService = new ResponseService(
      this.memoryService, this.session, this.planService, this.onTrace, this.memory,
      goalGraphSuggestMode === 'enabled'
        ? async (thread, onUsage, sessionId) => {
            const bigPicture = await this.nextStepContext(sessionId, { focusThreadId: thread.id })
            return (await proposeNextSteps(thread, this.llmClient, goalGraphSuggestMode, this.model, onUsage, bigPicture)).map(({ goalThreadId: _goalThreadId, ...suggestion }) => suggestion)
          }
        : undefined,
    )
    this.askClarification = new AskClarificationService(this.memory, this.session, this.harnessBridge, this.responseService, this.onTrace)

    // Fire-and-forget, not awaited: a large pre-existing history must not delay this
    // constructor or the first turn/render. Covers every front end (CLI, chat-ui, desktop)
    // and both construction paths (this constructor directly, and static create() below,
    // which calls back into it) since it's rooted here rather than in cli.ts.
    void this.session.backfillMessageIndex()
    // Fire-and-forget, same reasoning as backfillMessageIndex above.
    void this.session.sweepAbandonedPendingActionsOnStartup()
  }

  /**
   * Preferred entry point in a browser: defaults transcript, learning, and
   * checkpoint storage to their IndexedDB/Dexie-backed implementations so all
   * three survive a page reload, instead of the in-process defaults the plain
   * constructor uses. Falls back to the same in-memory defaults as `new
   * PersonalAssistant(...)` outside a browser (e.g. the CLI).
   */
  static async create(options: PersonalAssistantOptions): Promise<PersonalAssistant> {
    if (!isBrowser()) return new PersonalAssistant(options)

    const memory = options.memory ?? new IndexedDBAdapter({ namespace: 'personal-assistant' })
    const experienceStore = options.experienceStore ?? await DexieExperienceStore.create({ namespace: 'personal-assistant' })
    const checkpointStore = options.checkpointStore ?? new IndexedDBAdapter({ namespace: 'personal-assistant-checkpoints' })

    return new PersonalAssistant({ ...options, memory, experienceStore, checkpointStore })
  }

  /**
   * The bigger picture both next-step proposers get (see next-step-context.ts): earlier
   * conversation, the steps taken this turn, and every goal thread the session tracks. Best-effort —
   * any read failure just yields no extra context, never a failed turn. At turn end the focus
   * thread is the one the graph currently marks active; for a thread that just finished it is that
   * thread.
   */
  private async nextStepContext(
    sessionId: string,
    opts: { focusThreadId?: string; currentUserMessage?: string; sources?: AssistantSource[] },
  ): Promise<NextStepContext> {
    try {
      const transcript = await this.session.getTranscript(sessionId)
      const goalGraph = (await loadGoalGraphRecord(this.memory, sessionId, this.session.undoWorkspace())) ?? undefined
      return buildNextStepContext({
        transcript,
        currentExchange: opts.currentUserMessage === undefined ? undefined : { userMessage: opts.currentUserMessage },
        goalGraph,
        focusThreadId: opts.focusThreadId ?? goalGraph?.activeThreadId ?? undefined,
        sources: opts.sources,
      })
    } catch {
      return {}
    }
  }

  /**
   * Thin wrapper around runTurn(): emits turn_start/turn_end/error trace events
   * around the actual logic, so every one of runTurn's return paths gets a
   * matching turn_end without instrumenting each one individually.
   */
  async turn(userMessage: string, options: TurnOptions = {}): Promise<AssistantTurnResult> {
    const sessionId = options.sessionId ?? 'default'
    // Reset per turn — runTurn flips it to 'flat-oneloop'/'batch-oneloop' only on the flag-ON
    // paths that actually defer the tool loop into a harness-driven proposer.
    this.lastProposerKind = 'posthoc'
    this.onTrace?.({ kind: 'turn_start', sessionId, message: userMessage })
    this.onDebugLog?.({ kind: 'user_message', sessionId, content: userMessage })

    // Pre-turn only, never mid-turn — a turn already in flight always finishes (see
    // spend-cap.ts's checkSpendCap doc comment). A pendingActionId call is a continuation of a
    // turn that already passed this check when it first started (the message-level risk gate or
    // a staged write/shell/batch action awaiting the user's yes/no), not a new turn on its own,
    // so it's exempt — otherwise a turn that was allowed to start, then paused for approval,
    // could get silently stuck refusing to ever resolve once the ceiling was crossed by
    // something else in between.
    if (!options.pendingActionId) {
      const check = await this.session.checkSpendCapForTurn(sessionId)
      if (!check.allowed) {
        this.onTrace?.({ kind: 'turn_end', sessionId, status: 'escalated' })
        return { status: 'escalated', reply: null, reason: check.reason, proposerKind: 'posthoc' }
      }
    }

    try {
      const result = await this.runTurn(userMessage, options, sessionId)
      // Every return path leaves proposerKind unset — stamp the one runTurn resolved (defaults
      // to 'posthoc'). A path that already set it explicitly (the spend-cap early return above)
      // never reaches here.
      result.proposerKind = this.lastProposerKind
      // R7: after a full turn (ok, and not the triviality fast path), propose next steps for the
      // user. Best-effort — proposeTurnNextSteps never throws — and its one LLM call is folded into
      // this turn's usage/spend like every other call the turn made.
      if (result.status === 'ok' && !result.harnessSkipped && result.reply && this.goalGraphSuggestMode === 'enabled') {
        const extra: TokenUsage[] = []
        const bigPicture = await this.nextStepContext(sessionId, { currentUserMessage: userMessage, sources: result.sources })
        const nextSteps = await proposeTurnNextSteps({ userMessage, reply: result.reply }, this.llmClient, this.goalGraphSuggestMode, this.model, (u) => extra.push(u), bigPicture)
        if (nextSteps.length > 0) result.nextSteps = nextSteps
        for (const u of extra) {
          result.usage = {
            inputTokens: (result.usage?.inputTokens ?? 0) + u.inputTokens,
            outputTokens: (result.usage?.outputTokens ?? 0) + u.outputTokens,
            costUsd: u.costUsd !== undefined ? (result.usage?.costUsd ?? 0) + u.costUsd : result.usage?.costUsd,
            cachedInputTokens: u.cachedInputTokens !== undefined ? (result.usage?.cachedInputTokens ?? 0) + u.cachedInputTokens : result.usage?.cachedInputTokens,
          }
        }
      }
      if (result.status === 'ok') await this.session.recordSpend(sessionId, result.usage)
      this.onTrace?.({ kind: 'turn_end', sessionId, status: result.status })
      // cachedInputTokens is included here (not just in the usage/cost UI) specifically so it's
      // visible in the same terminal log stream as every other debug-log line — the only way to
      // confirm, from a real live response, whether a given backend/model is actually reporting
      // prompt-cache hits at all (several OpenAI-compatible providers, OpenRouter included, only
      // populate usage.prompt_tokens_details.cached_tokens for some underlying models).
      const cacheNote = result.usage?.cachedInputTokens !== undefined ? ` [cached: ${result.usage.cachedInputTokens}/${result.usage.inputTokens} input tokens]` : ''
      this.onDebugLog?.({
        kind: 'assistant_reply',
        sessionId,
        content: `[${result.status}]${result.riskLevel ? ` (${result.riskLevel})` : ''}${cacheNote} ${result.reply ?? result.reason ?? '(no reply)'}`,
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.onTrace?.({ kind: 'error', message })
      this.onDebugLog?.({ kind: 'assistant_reply', sessionId, content: `[threw] ${message}` })
      throw err
    }
  }

  /** Persisted alongside transcript/facts/plan — survives a process restart, same as everything else keyed by sessionId, so the ceiling is genuinely cross-session, not just cross-turn within one process lifetime. */
  async getSpendState(sessionId: string): Promise<SpendState> {
    return this.session.getSpendState(sessionId)
  }

  /** The session's conversation transcript, oldest first — same array `turn()` reads/appends to. Used by `/export`. */
  async getTranscript(sessionId: string): Promise<ChatMessage[]> {
    return this.session.getTranscript(sessionId)
  }

  /**
   * Records a message-level risk-gate decline as a resolved, paired exchange, once the caller
   * (cli.ts) knows the final answer was "no". See AssistantSession.recordDeclinedRequest's doc
   * comment for the full reasoning.
   */
  async recordDeclinedRequest(sessionId: string, userMessage: string, reason: string): Promise<void> {
    return this.session.recordDeclinedRequest(sessionId, userMessage, reason)
  }

  /** Ends the current conversation — see AssistantSession.clearSession's doc comment for exactly what is and isn't cleared. */
  async clearSession(sessionId: string): Promise<void> {
    return this.session.clearSession(sessionId)
  }

  /**
   * P1 of the internal plan — explicit entry point into plan mode's
   * exclusive drafting state. No production caller yet: P3 will later set this automatically from
   * a judgment-based trigger ahead of TurnInterpreter's classification. Until then this is reached
   * only by a caller (a future `/plan` CLI command, or a test) that wants to exercise the drafting
   * loop directly. Once active, every `turn()` call for this session routes to
   * `PlanDraftingService` instead of the normal pipeline until the user says an explicit
   * cancel/abort phrase.
   */
  async enterPlanMode(sessionId: string): Promise<{ active: boolean; draftId: string }> {
    return this.session.enterPlanMode(sessionId)
  }

  /**
   * P7 of the internal plan — the raw current `PlanRecord` for this
   * session, regardless of `mode`, so a caller (chat-ui's persistent banner, the CLI's `/plan
   * show`) can display live drafting/awaiting-approval state independent of any single turn's
   * own result (a `needs_plan_approval` result only carries a snapshot at the moment it's
   * staged; a plain `status: 'ok'` drafting reply doesn't carry `rationale`/`reviewNotes` at
   * all). Returns `null` when no plan record exists for this session yet.
   */
  async getPlanState(sessionId: string): Promise<PlanRecord | null> {
    return this.planService.loadPlanRecord(sessionId)
  }

  /**
   * Phase 7 of plans/hierarchical_goal_tree_and_steering_plan.html (R5, "Visibility") — the shared
   * read surface behind the CLI's `/goals` and chat-ui's GoalsPanel, analogous to `searchTranscript`
   * above. A pure query over whatever Phases 4-5 already populate in this session's
   * `GoalGraphRecord`; never mints or mutates one. Returns the empty state for a session with no
   * goal graph yet, same "nothing to show" convention `getGoalGraphState` itself documents.
   */
  async getGoalGraphState(sessionId: string): Promise<GoalGraphState> {
    return getGoalGraphState(this.memory, sessionId, this.session.undoWorkspace())
  }

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
  async sketchPlan(sessionId: string, request: string): Promise<AssistantTurnResult> {
    const check = await this.session.checkSpendCapForTurn(sessionId)
    if (!check.allowed) {
      return { status: 'escalated', reply: null, reason: check.reason, proposerKind: 'posthoc' }
    }
    let usage: TokenUsage | undefined
    const result = await this.planSketch.sketch(request, (u) => {
      usage = u
    })
    result.usage = usage
    result.proposerKind = 'posthoc'
    await this.session.recordSpend(sessionId, usage)
    return result
  }

  /** Scoped recovery for a stuck harness checkpoint — see AssistantSession.clearCheckpoint's doc comment. */
  async clearCheckpoint(sessionId: string): Promise<{ cleared: boolean; stepsUsed?: number; currentNode?: string }> {
    return this.session.clearCheckpoint(sessionId)
  }

  /** Read-only counterpart to clearCheckpoint — see AssistantSession.getCheckpointStatus's doc comment. */
  async getCheckpointStatus(sessionId: string): Promise<{ present: boolean; stepsUsed?: number; currentNode?: string; failedResumeAttempts: number }> {
    return this.session.getCheckpointStatus(sessionId)
  }

  /** Removes the most recent exchange from conversation history — see AssistantSession.undoLastTurn's doc comment. */
  async undoLastTurn(sessionId: string): Promise<{ undone: boolean }> {
    return this.session.undoLastTurn(sessionId)
  }

  /** Real filesystem effects still on record as revertible, newest first — see AssistantSession.listUndoLogEntries's doc comment. */
  async listUndoLogEntries(): Promise<UndoLogEntry[]> {
    return this.session.listUndoLogEntries()
  }

  /** Stages a revert of undo-log entry `id` as its own approval-gated pending action — see AssistantSession.stageUndoAction's doc comment. */
  async stageUndoAction(id: string): Promise<{ status: 'staged'; pendingActionId: string; reason: string } | { status: 'error'; message: string }> {
    return this.session.stageUndoAction(id)
  }

  /** Read-only snapshot of what this session/assistant has learned — see MemoryService.getMemorySummary's doc comment. Used by `/memory`. */
  async getMemorySummary(sessionId: string): Promise<MemorySummary> {
    return this.memoryService.getMemorySummary(sessionId)
  }

  /** Full, unbounded snapshot of everything learned so far — see MemoryService.exportMemory's doc comment. Used by `/memory export`. */
  async exportMemory(sessionId: string): Promise<MemoryExport> {
    return this.memoryService.exportMemory(sessionId)
  }

  /**
   * `/memory confirm <n|category>` — `selector` is either a 1-based index into `/memory`'s
   * flat, display-order "Pending confirmation" listing, or one of FactCategory's names for a
   * bulk confirm. Phase 3 of the internal plan.
   * `conflictNotices` (if any) are advisory only — every confirmed fact is promoted regardless,
   * matching how every other contradiction check in this codebase never gates belief admission.
   */
  async confirmPendingFact(selector: string): Promise<MemoryPendingOutcome> {
    const category = asFactCategory(selector)
    if (category) {
      const outcomes = await this.memoryService.confirmPendingCategory(category)
      if (outcomes.length === 0) return { ok: false, error: `No pending facts in category "${category}".` }
      return { ok: true, facts: outcomes.map((o) => o.fact), conflictNotices: outcomes.map((o) => o.conflictNotice).filter((n): n is string => Boolean(n)) }
    }
    const index = parsePendingIndex(selector)
    if (index === undefined) return { ok: false, error: 'Usage: /memory confirm <n> or /memory confirm <category>' }
    const outcome = await this.memoryService.confirmPendingFact(index)
    if (!outcome) return { ok: false, error: `No pending fact #${index + 1}.` }
    return { ok: true, facts: [outcome.fact], conflictNotices: outcome.conflictNotice ? [outcome.conflictNotice] : [] }
  }

  /** `/memory reject <n|category>` — mirror of confirmPendingFact, see its doc comment for `selector`'s shape. */
  async rejectPendingFact(selector: string): Promise<MemoryPendingOutcome> {
    const category = asFactCategory(selector)
    if (category) {
      const rejected = await this.memoryService.rejectPendingCategory(category)
      if (rejected.length === 0) return { ok: false, error: `No pending facts in category "${category}".` }
      return { ok: true, facts: rejected, conflictNotices: [] }
    }
    const index = parsePendingIndex(selector)
    if (index === undefined) return { ok: false, error: 'Usage: /memory reject <n> or /memory reject <category>' }
    const fact = await this.memoryService.rejectPendingFact(index)
    if (!fact) return { ok: false, error: `No pending fact #${index + 1}.` }
    return { ok: true, facts: [fact], conflictNotices: [] }
  }

  /**
   * `/memory forget <n>` — `n` is a 1-based index into `/memory`'s "Facts I know" listing (durable
   * facts first, then session facts — the same order `getMemorySummary()` returns). Unlike
   * confirm/reject, there's no category form: a durable/session fact carries no `category` field,
   * only pending model-inferred guesses do. Hard-deletes rather than routing through
   * REJECTED_FACTS_KEY — see MemoryService.forgetFact's doc comment.
   */
  async forgetFact(selector: string, sessionId: string): Promise<MemoryPendingOutcome> {
    const index = parsePendingIndex(selector)
    if (index === undefined) return { ok: false, error: 'Usage: /memory forget <n>' }
    const fact = await this.memoryService.forgetFact(index, sessionId)
    if (!fact) return { ok: false, error: `No fact #${index + 1}.` }
    return { ok: true, facts: [fact], conflictNotices: [] }
  }

  /** Ranked search over the per-message index — see AssistantSession.searchTranscript's doc comment. Used by `/search`. */
  async searchTranscript(query: string, topK = 10): Promise<TranscriptSearchHit[]> {
    return this.session.searchTranscript(query, topK)
  }

  /** Changes the model used by every subsequent `turn()` call, mid-session — no reconstruction needed. Used by `/model`. Every collaborator constructed above reads this field through a getter closure, never a captured string, so this takes effect for all of them immediately. */
  setModel(model: string | undefined): void {
    this.model = model
  }

  /** The project label new project-scoped facts are tagged with and existing ones are filtered against this session — see UserFact.project's doc comment. Empty string when none is set (cli.ts's buildAssistant always resolves one from workspaceRoot, but a bare `new PersonalAssistant()` with no `activeProject` option should read as "no project concept" rather than `undefined`). */
  getActiveProject(): string {
    return this.activeProject ?? ''
  }

  /** Mid-session override for `activeProject`, mirroring setModel — takes effect on the very next turn via the same getter-closure MemoryService already reads through. Used by `/project <name>` outside the CLI's own /config-set-and-reload path (e.g. a future non-CLI embedder). */
  setActiveProject(project: string | undefined): void {
    this.activeProject = project
  }

  /**
   * The sequencer: constructs no state of its own beyond what a single turn needs
   * (transcript/facts/system prompt, the turn-scoped usage accumulator), and otherwise just
   * calls each collaborator in the same order the pre-split code ran their logic inline, wiring
   * each one's output into the next. See turn-interpreter.ts/agent-loop.ts/harness-bridge.ts/
   * response-service.ts for where the real control-flow subtlety (the batch-research path, the
   * plan-cancel bypass, the triviality fast path) actually lives now.
   */
  private async runTurn(userMessage: string, options: TurnOptions, sessionId: string): Promise<AssistantTurnResult> {
    const transcriptKey = `transcript:${sessionId}`

    // Phase 5 of plans/hierarchical_goal_tree_and_steering_plan.html — the Scheduler's natural,
    // turn-scoped selection pass (goal-thread-scheduler.ts's selectActiveThread): the per-turn
    // analog of "off a control_state BLOCKED trigger" from the plan's resolved "ACTIVE-pointer
    // write authority" decision, since a GoalThread's TaskGraph is only ever loaded/swapped at
    // turn boundaries, never hot-swapped mid-iteration. Gated purely on options.steeringChannel
    // being present — same "caller decides, PersonalAssistant never reads goalGraphMode itself"
    // convention Phase 4 established (TurnOptions.steeringChannel's own doc comment) — so every
    // caller that predates goalGraphMode, and every flag-off session, sees zero behavior change
    // (INV-43): goalThreadId stays undefined and every plan-mode/drafting call below resolves to
    // its exact original session-global key.
    let goalThreadId: string | undefined
    if (options.steeringChannel) {
      const fsPersistence = this.session.undoWorkspace()
      const goalGraph = (await loadGoalGraphRecord(this.memory, sessionId, fsPersistence)) ?? createEmptyGoalGraphRecord()
      const selection = selectActiveThread(goalGraph)
      if (selection.switched) {
        await saveGoalGraphRecord(this.memory, sessionId, selection.record, fsPersistence)
      }
      goalThreadId = selection.activeThreadId ?? undefined
    }

    // Accumulates usage across every real LLM call this turn makes — a turn can make several
    // (decomposition, plan-building, up to maxSteps tool-loop round trips) — into one turn-level
    // total attached to a successful AssistantTurnResult. Absent (stays undefined) on a turn
    // that never calls onUsage at all — same "absent when unused" convention trace/sources
    // already follow.
    let usageTotal: TokenUsage | undefined
    const accumulateUsage = (u: TokenUsage): void => {
      usageTotal = {
        inputTokens: (usageTotal?.inputTokens ?? 0) + u.inputTokens,
        outputTokens: (usageTotal?.outputTokens ?? 0) + u.outputTokens,
        costUsd: u.costUsd !== undefined ? (usageTotal?.costUsd ?? 0) + u.costUsd : usageTotal?.costUsd,
        cachedInputTokens: u.cachedInputTokens !== undefined ? (usageTotal?.cachedInputTokens ?? 0) + u.cachedInputTokens : usageTotal?.cachedInputTokens,
      }
    }

    // A staged action is resumed by ID, not re-derived from a second LLM call — see T4 in
    // the internal plan for why a second call has no guarantee of
    // proposing identical content (and, for a shell command, no guarantee of proposing the same
    // command at all).
    if (options.pendingActionId) {
      return this.actionApproval.resolvePendingAction(sessionId, transcriptKey, options.pendingActionId, options.approved ?? false, userMessage)
    }

    // Q2 — resolving a staged needs_clarification result is a resume, not a fresh turn: the
    // effective askMode carried here only decides whether a *follow-up* (INV-37) escalation
    // re-stages instead of falling back to the terminal `escalated` path — see
    // AskClarificationService.resolvePendingClarification's own EscalationHalt catch.
    if (options.pendingClarificationId) {
      // P8 of the internal plan — a nested ask raised mid-draft stages
      // into PlanDraftingService's own side channel, not AskClarificationService's (there is no
      // harness run mid-draft to resume). Both produce the same opaque `pendingClarificationId`
      // shape, so the caller (chat-ui/CLI) never needs to know which one it's resolving — this is
      // the one place that has to check, by peeking which store actually staged it.
      if (await this.planDrafting.isPendingAsk(options.pendingClarificationId)) {
        return this.planDrafting.resolvePendingAsk(sessionId, transcriptKey, options.pendingClarificationId, options.clarificationAnswer, accumulateUsage)
      }
      const askModeEnabledForResume = resolveEffectiveAskMode({
        globalEnabled: this.askMode === 'enabled',
        sessionAskMode: options.askMode === undefined ? undefined : options.askMode === 'enabled',
      })
      return this.askClarification.resolvePendingClarification(sessionId, transcriptKey, options.pendingClarificationId, options.clarificationAnswer, askModeEnabledForResume)
    }

    // P2 — resolving a staged needs_plan_approval result. `resolvePendingPlanApproval` mutates
    // plan state (or leaves it untouched, fail-closed) and either returns a terminal result
    // (stale/missing ID, no decision, or a failed edit/activation) or `{ fallThrough: true }`,
    // meaning we keep going below with this SAME userMessage — approve/approve-with-edits lets
    // the ordinary pipeline pick up the newly-`active` plan exactly the way a freshly
    // template-matched plan already does today (TurnInterpreter.resolveTasks -> loadActivePlan),
    // decline lets it fall through with no plan at all. Checked before planMode.active (below) —
    // same position pendingActionId/pendingClarificationId already occupy.
    if (options.planApprovalId) {
      const outcome = await this.planApproval.resolvePendingPlanApproval(sessionId, options.planApprovalId, options.planDecision, options.planEdits, goalThreadId)
      if (!('fallThrough' in outcome)) return outcome
    }

    // P1 of the internal plan — the exclusive plan-mode session-state
    // switch: while active, every message (short of an explicit cancel phrase, handled inside
    // PlanDraftingService itself) is routed here instead of TurnInterpreter's normal
    // classify/tool-loop pipeline below, and no tool loop of any kind runs for this turn (INV-30).
    // No production caller ever sets this today (see PersonalAssistant.enterPlanMode's doc
    // comment) — inert by construction until P3 wires an automatic trigger.
    const planModeState = await this.session.getPlanModeState(sessionId, goalThreadId)
    if (planModeState?.active) {
      // No `seed` passed here (this is a resumed/manual drafting turn, not a fresh auto-triggered
      // one) — draftTurn's `{ fallThrough: true }` outcome is only ever produced when a `seed` is
      // given, so this is always a real AssistantTurnResult in practice; the `in` check just keeps
      // the return type honest without asserting past PlanDraftOutcome's union.
      const draftOutcome = await this.planDrafting.draftTurn(sessionId, transcriptKey, userMessage, accumulateUsage, undefined, goalThreadId)
      if (!('fallThrough' in draftOutcome)) return draftOutcome
    }

    const transcript = await this.session.loadAndCompactTranscript(sessionId)
    const { facts, factsBlock } = await this.memoryService.loadFacts(sessionId)
    const { remindersBlock } = await this.memoryService.loadActiveReminders()
    const systemPrompt = `${SYSTEM_PROMPT}${factsBlock}${remindersBlock}`

    const interpretation = await this.turnInterpreter.interpretIntent({
      userMessage,
      sessionId,
      toolLoopWillRun: this.toolLoopWillRun,
      approved: options.approved ?? false,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      onUsage: accumulateUsage,
    })

    if (interpretation.kind === 'bypass') {
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: interpretation.transcriptAppend.user })
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: interpretation.transcriptAppend.assistant })
      this.onTrace?.({ kind: 'plan_updated', templateName: interpretation.planUpdatedTrace.templateName, completionPct: interpretation.planUpdatedTrace.completionPct })
      classifyAndTraceExecutionMode(this.onTrace, { isPlanCancelBypass: true, isBatchResearch: false, isTrivial: false, requiresApproval: false })
      return interpretation.result
    }

    this.onTrace?.({ kind: 'risk_classified', riskLevel: interpretation.classification.riskLevel, requiresApproval: interpretation.classification.requiresApproval })

    if (interpretation.kind === 'needs_approval') {
      classifyAndTraceExecutionMode(this.onTrace, { isPlanCancelBypass: false, isBatchResearch: false, isTrivial: false, requiresApproval: true })
      return interpretation.result
    }

    const { classification, planForCancelCheck } = interpretation

    // P3 of the internal plan — the generalized, judgment-based auto-entry
    // into plan mode's exclusive drafting loop (P1/P2), replacing the old direct-to-active
    // template-match path (TurnInterpreter.resolveTasks used to build and immediately activate a
    // PlanRecord the instant a template matched, with no approval step at all). A template match
    // still seeds the draft with that template's own skeleton (today's behavior, reused — see
    // PlanDraftingService.draftTurn/seedFromTemplate), and a request with no template match but a
    // genuine multi-step shape (classification.needsMultiStepPlan — includes a code-implementation
    // request per Section 5b-6) seeds a from-scratch draft, grounded via a bounded
    // read_file/list_directory walk. Checked here (before the tool loop / draftReply generation
    // below ever runs) rather than inside resolveTasks, so drafting stays genuinely exclusive
    // (INV-30) instead of running a wasted ordinary turn alongside it. Nothing runs until the user
    // explicitly approves the finished draft (P2) — auto-entry is safe specifically because that
    // approval gate is mandatory and never risk-tiered. `planForCancelCheck` null is required
    // defensively even though `classification.matchedPlanTemplate`/`needsMultiStepPlan` are already
    // gated to false whenever a plan is active (turn-intent-classifier.ts) — belt and suspenders
    // against ever entering drafting on top of an already-running plan.
    // P11 — 'legacy' (the default) keeps this auto-trigger off: a plan-shaped classification
    // just falls through to resolveTasks below, which already treats matchedPlanTemplate/
    // needsMultiStepPlan as a pure observability trace once plan mode is bypassed (see its own
    // doc comment) rather than building/activating a PlanRecord — this is the one production
    // call site that ever calls enterPlanMode, so gating it here makes the entire P1-P8/P10
    // apparatus downstream stay dormant for real traffic without needing a flag check anywhere
    // else (manual/test-only enterPlanMode calls are deliberately left ungated — see
    // plan-mode-flag.ts's doc comment).
    if (this.planMode === 'gated' && !planForCancelCheck && (classification.matchedPlanTemplate !== null || classification.needsMultiStepPlan)) {
      await this.session.enterPlanMode(sessionId, goalThreadId)
      this.onTrace?.({ kind: 'plan_classified', isCandidate: true, matchedTemplate: classification.matchedPlanTemplate })
      const draftOutcome = await this.planDrafting.draftTurn(
        sessionId,
        transcriptKey,
        userMessage,
        accumulateUsage,
        {
          templateName: classification.matchedPlanTemplate,
          grounded: classification.matchedPlanTemplate === null,
        },
        goalThreadId,
      )
      // Validation (P3): a fresh draft that fails outright (malformed/insufficient LLM output)
      // falls back to not entering plan mode at all — draftTurn already exited plan mode and left
      // the transcript untouched, so ordinary turn handling below picks up this same userMessage
      // cleanly, exactly like a failed old-style buildPlanFromTemplate call used to fall through
      // to ad hoc decomposition.
      if (!('fallThrough' in draftOutcome)) return draftOutcome
    }

    // Q2 — the effective askMode for this turn (Q1's three-tier INV-29 resolution: global config
    // AND session override AND per-call-site, most-restrictive-wins). Threaded into
    // harnessBridge.run() (so the harness's own supervisor ASK_USER path batches consistently,
    // and so its checkpoint survives a structured-question escalation) and into the
    // EscalationHalt catch below (so it — not the harness — decides whether to promote to
    // needs_clarification).
    const askModeEnabled = resolveEffectiveAskMode({
      globalEnabled: this.askMode === 'enabled',
      sessionAskMode: options.askMode === undefined ? undefined : options.askMode === 'enabled',
    })

    let draftReply: string
    let sources: AssistantSource[] | undefined
    // Set only when the batch-research path (AgentLoop.runBatchToolLoop) drove this turn —
    // carried into every trace built below so AssistantTrace.batchBudget stays populated even
    // though the batch loop itself finishes long before the harness run that ultimately builds
    // `trace`.
    let batchBudgetTrace: BatchBudgetTrace | undefined
    // Phase 4 — see TurnOptions.steeringChannel's doc comment. Built fresh each turn (cheap: no
    // LLM/IO cost until channel.poll() actually classifies a drained message) rather than reused
    // across turns, since goal-graph state itself is loaded fresh from `memory` on each poll().
    const steeringAdapter = options.steeringChannel
      ? createSteeringReconcileChannel({
          steeringChannel: options.steeringChannel,
          sessionId,
          memory: this.memory,
          llmClient: this.llmClient,
          model: this.model,
          onUsage: accumulateUsage,
          fsPersistence: this.session.undoWorkspace(),
        })
      : undefined

    // R3 of the internal plan: set only on the flag-ON, non-batch,
    // non-trivial path below — passed to harnessBridge.run() as the toolExecutors 'default' entry
    // instead of precomputing draftReply via AgentLoop.runToolLoop up front, so the harness's own
    // driveMainLoop drives the actual tool calls one iteration at a time.
    let oneLoopProposer: ((toolCtx: ToolExecutorContext) => Promise<unknown>) | undefined
    // The mutable array AgentLoop.createOneLoopProposer's proposer pushes to as it dispatches
    // tool calls during the harness run — read back into `sources` once that run finishes (see
    // below), mirroring `loopResult.sources` on the flag-OFF path.
    let oneLoopSources: AssistantSource[] | undefined
    // R4: set only on the flag-ON batch path — the batch counterpart to oneLoopSources, since a
    // batch turn also needs to read its BatchBudgetTrace back once the harness run building it
    // (via AgentLoop.createBatchOneLoopProposer) has finished, mirroring `loopResult.batchBudget`
    // on the flag-OFF path.
    let oneLoopBatchBudget: (() => BatchBudgetTrace | undefined) | undefined
    if (this.toolLoopWillRun) {
      // Gated entry point for the batch-research path: only when webTools is configured, the
      // message is an explicit ≥3-item list (batch-list-detector.ts's narrow, syntactic-only
      // shape), and this turn isn't already inside a plan-driven run (planForCancelCheck is the
      // same "is there an active plan" check TurnInterpreter.resolveTasks re-derives as
      // `activePlan`). Every other case falls straight into today's flat AgentLoop.runToolLoop,
      // byte-for-byte unchanged.
      const batch = this.webTools && !planForCancelCheck ? detectHomogeneousBatchList(userMessage) : null
      // R3 routed the flat (non-batch) tool loop under the harness's own driveMainLoop when the
      // flag is enabled; R4 (the internal plan) does the same for batch
      // research, via AgentLoop.createBatchOneLoopProposer — so `!batch` no longer excludes a
      // turn from useOneLoop. A trivial turn still returns below without ever calling
      // harnessBridge.run() (see classification.isTrivial below) — there is no harness run to
      // defer the tool loop into, so it keeps resolving synchronously here too, same as flag-OFF.
      const useOneLoop = this.oneLoopMode === 'enabled' && !classification.isTrivial

      if (useOneLoop && batch) {
        this.lastProposerKind = 'batch-oneloop'
        const built = this.agentLoop.createBatchOneLoopProposer(
          batch.items, sessionId, userMessage, systemPrompt, options.onToken, options.onToolStep, accumulateUsage,
        )
        oneLoopProposer = built.proposer
        oneLoopSources = built.sources
        oneLoopBatchBudget = built.getBatchBudget
        draftReply = ''
      } else if (useOneLoop) {
        this.lastProposerKind = 'flat-oneloop'
        const built = this.agentLoop.createOneLoopProposer(
          sessionId, transcript, userMessage, systemPrompt, options.onToken, options.onToolStep, accumulateUsage, classification.riskLevel,
          steeringAdapter?.takeNotes,
        )
        oneLoopProposer = built.proposer
        oneLoopSources = built.sources
        draftReply = ''
      } else {
        // Phase 4c: one live ControlState per turn, shared across every tool call this turn
        // makes — including across batch items (see AgentLoop.createControlPlaneState /
        // tool-control-plane.ts) — so a failure pattern discovered partway through the turn can
        // actually gate a later call via checkToolPolicy. The flag-ON harness-driven proposers
        // above build their own via createControlPlaneState() too (and additionally pin the
        // harness's own live per-iteration ControlState on as the gate floor — see
        // createHarnessProposer's doc comment); this branch just constructs it here instead.
        const controlPlaneState = this.agentLoop.createControlPlaneState()
        const loopResult = batch
          ? await this.agentLoop.runBatchToolLoop(batch.items, sessionId, userMessage, systemPrompt, options.onToken, options.onToolStep, accumulateUsage, controlPlaneState)
          : await this.agentLoop.runToolLoop(sessionId, transcript, userMessage, systemPrompt, options.onToken, options.onToolStep, accumulateUsage, classification.riskLevel, controlPlaneState)

        if (loopResult.kind === 'needs_approval' || loopResult.kind === 'escalated') {
          return this.buildToolLoopPauseResult(sessionId, transcriptKey, userMessage, loopResult, classification)
        }
        draftReply = loopResult.content
        sources = loopResult.sources.length > 0 ? loopResult.sources : undefined
        batchBudgetTrace = loopResult.batchBudget
      }
    } else {
      // The only real network call this turn makes — everything the harness does around it
      // (risk, gating, verification, recovery, review) is local bookkeeping. Read via callChat
      // (not callChatSync) so a caller-supplied onToken sees each chunk as it arrives;
      // accumulating here gives the exact same final string callChatSync would have returned
      // when no listener is attached.
      draftReply = ''
      for await (const token of this.llmClient.callChat(
        [{ role: 'system', content: systemPrompt }, ...transcript, { role: 'user', content: userMessage }],
        { model: this.model, onUsage: accumulateUsage },
      )) {
        draftReply += token
        options.onToken?.(token)
      }
    }

    // Self-contained factual questions ("what timezone is Tokyo in") skip the harness run
    // entirely — no verification/reviewer pass/checkpoint for this turn. Deliberately
    // conservative: see turn-intent-classifier.ts's isTrivial contract for what disqualifies a
    // turn from this path.
    this.onTrace?.({ kind: 'proposer_selected', proposerKind: this.lastProposerKind })
    this.onTrace?.({ kind: 'triviality_classified', isTrivial: classification.isTrivial })
    // Phase D3: recomputed via turn-policy.ts rather than read directly off
    // classification.requiresApproval — see turn-interpreter.ts's identical call for why.
    const turnPolicyDecision = evaluateTurnPolicy({ riskHint: classification.riskLevel, isBulkReminderRequest: classification.isBulkReminderRequest })
    classifyAndTraceExecutionMode(this.onTrace, {
      isPlanCancelBypass: false,
      isBatchResearch: batchBudgetTrace !== undefined,
      isTrivial: classification.isTrivial,
      requiresApproval: turnPolicyDecision.decision === 'REQUIRE_APPROVAL',
    })
    if (classification.isTrivial) {
      return this.responseService.buildTrivialResult({ sessionId, transcriptKey, userMessage, draftReply, classification, sources, batchBudgetTrace, usageTotal, onUsage: accumulateUsage })
    }

    // Cross-turn goal identity (goal-thread-identity.ts): which goal thread does this full turn
    // belong to? A continuation of an earlier goal brings that thread back into focus; anything
    // else starts its own. Same gate as the Scheduler pass above (the caller passed
    // `steeringChannel`, i.e. goalGraphMode is on), and never for a resumed turn — a staged-action
    // approval, clarification answer or plan decision continues the thread the previous turn already
    // resolved. (`approved` alone is not a resume marker: front ends pass `approved: false` on every
    // ordinary turn, and a message-level approval re-runs a message that never got a thread.)
    // Trivial one-liners returned just above, so they never create a thread or make this call.
    const isContinuation = options.pendingActionId !== undefined || options.pendingClarificationId !== undefined || options.planApprovalId !== undefined
    if (options.steeringChannel && this.memory && !isContinuation) {
      goalThreadId = (await resolveTurnGoalThread({
        userMessage,
        sessionId,
        memory: this.memory,
        llmClient: this.llmClient,
        model: this.model,
        onUsage: accumulateUsage,
        fsPersistence: this.session.undoWorkspace(),
      })) ?? goalThreadId
    }

    // A compound-looking request decomposes into multiple tasks, and/or an active/matched
    // durable plan drives this turn's task graph instead — see TurnInterpreter.resolveTasks.
    const { initialTasks, activePlan, planClassifiedTrace } =
      await this.turnInterpreter.resolveTasks({ userMessage, sessionId, classification, planForCancelCheck, onUsage: accumulateUsage })
    if (planClassifiedTrace) {
      this.onTrace?.({ kind: 'plan_classified', isCandidate: planClassifiedTrace.isCandidate, matchedTemplate: planClassifiedTrace.matchedTemplate })
    }

    // Eval harness only — see benchmark-injected-failure.ts. Wraps the one-loop proposer to
    // force a stall so the Trajectory Supervisor's stall edge is exercised in one turn.
    if (options.__benchmarkInjectedFailure && oneLoopProposer) {
      oneLoopProposer = wrapProposerWithInjectedFailure(oneLoopProposer, options.__benchmarkInjectedFailure)
    }

    try {
      const outcome = await this.harnessBridge.run({
        sessionId,
        userMessage,
        facts,
        // Phase 4 of the internal plan: the same
        // merged lexical+LLM list recordFacts() (called later, in responseService's build*Result)
        // derives its writes from — computed independently here (both calls are pure given the
        // same sessionId/userMessage/statedFacts) so the harness's World Model sees a same-turn
        // LLM-caught fact immediately instead of only after this turn's post-hoc recordFacts call.
        currentTurnFacts: buildTurnFacts(sessionId, userMessage, classification.statesDurableFacts),
        draftReply,
        classification,
        initialTasks,
        activePlan,
        sources,
        onProgress: options.onProgress,
        onUsage: accumulateUsage,
        oneLoopProposer,
        askModeEnabled,
        // Trajectory Supervisor GATHER_EVIDENCE host (S5). Bound to this turn's read-only
        // tools + risk hint; inert unless resolveSupervisorEnabled() also wires a supervisorDecider
        // (harness-bridge.ts), and then only reached on a real stall edge.
        runInvestigation: resolveSupervisorEnabled()
          ? (req) => this.agentLoop.runSupervisorInvestigation(req, { riskHint: classification.riskLevel })
          : undefined,
        updateChannel: steeringAdapter?.channel,
      })

      // R3: oneLoopSources is only set on the flag-ON path above, and only gets pushed to once
      // the harness run just awaited has actually dispatched tool calls through the proposer — so
      // this can only be read back afterward, unlike the flag-OFF path's `sources`, which is
      // already known by the time harnessBridge.run() is called.
      if (oneLoopSources) sources = oneLoopSources.length > 0 ? oneLoopSources : undefined
      // R4: the batch counterpart to the sources read-back above — only set once the harness run
      // driven by AgentLoop.createBatchOneLoopProposer has reached its 'synthesize' phase.
      if (oneLoopBatchBudget) batchBudgetTrace = oneLoopBatchBudget()

      if (outcome.status === 'paused') {
        return this.responseService.buildPausedResult({
          sessionId,
          transcriptKey,
          userMessage,
          draftReply,
          classification,
          activePlan,
          checkpoint: outcome.checkpoint,
          lastVerification: outcome.lastVerification,
          layerActivity: outcome.layerActivity,
          sources,
          batchBudgetTrace,
          usageTotal,
          onUsage: accumulateUsage,
          goalThreadId,
        })
      }

      return this.responseService.buildSuccessResult({
        sessionId,
        transcriptKey,
        userMessage,
        draftReply,
        classification,
        activePlan,
        result: outcome.result,
        lastVerification: outcome.lastVerification,
        layerActivity: outcome.layerActivity,
        sources,
        batchBudgetTrace,
        usageTotal,
        onUsage: accumulateUsage,
        goalThreadId,
      })
    } catch (err) {
      if (err instanceof EscalationHalt) {
        // Q2 — a populated `blocker.questions` (Q0) with the effective askMode enabled promotes
        // to needs_clarification instead of the terminal escalated/reply:null path; flag-off or
        // no `questions` at all falls straight through to buildEscalatedResult, byte-identical to
        // pre-Q2 output.
        if (askModeEnabled && err.blocker.questions && err.blocker.questions.length > 0) {
          return this.askClarification.stageAndRespond({
            sessionId,
            transcriptKey,
            userMessage,
            questions: err.blocker.questions,
            classification,
            activePlan,
            facts,
            draftReply,
          })
        }
        return this.responseService.buildEscalatedResult({ sessionId, transcriptKey, userMessage, err, classification })
      }
      // R3 of the internal plan: the harness-driven proposer's
      // counterpart to the flag-OFF loopResult.kind === 'needs_approval'/'escalated' branches
      // above — execute.ts rethrows a HarnessPauseSignal (which OneLoopPause implements)
      // unexamined, so it propagates out of harnessBridge.run() as a thrown error rather than a
      // `{ status: 'paused' }` outcome; caught here instead.
      if (err instanceof OneLoopPause) {
        // P10: activePlan/err.currentTaskId give buildToolLoopPauseResult what it needs for the
        // INV-36 trust check — this is the only call site with a real answer for "which task was
        // RUNNING", since it's reached only once the harness has actually started driving the
        // plan's task graph (see that method's own doc comment on why the flag-OFF call site
        // below can't supply either).
        return this.buildToolLoopPauseResult(sessionId, transcriptKey, userMessage, err.result, classification, activePlan, err.currentTaskId)
      }
      throw err
    } finally {
      // R4: whatever steeringAdapter's channel never got around to classifying this turn (the
      // harness run ended — DONE, paused, or escalated — before the queue drained, or this turn's
      // harness run threw before ever reaching checkCallerUpdates) goes back onto the caller's own
      // channel, never dropped. See TurnOptions.steeringChannel's doc comment.
      if (steeringAdapter && options.steeringChannel) {
        for (const event of steeringAdapter.drainUnconsumed()) {
          options.steeringChannel.enqueue(event.message)
        }
      }
    }
  }

  /**
   * Shared by the flag-OFF flat/batch tool loop's own needs_approval/escalated ToolLoopResult and
   * the flag-ON harness-driven proposer's equivalent OneLoopPause (R3 of
   * the internal plan, see runTurn's two call sites) — "the model wants
   * to write/run/send something" or "the tool loop gave up" means the same thing to the caller
   * regardless of which loop discovered it.
   */
  private async buildToolLoopPauseResult(
    sessionId: string,
    transcriptKey: string,
    userMessage: string,
    loopResult: Extract<ToolLoopResult, { kind: 'needs_approval' | 'escalated' }>,
    classification: TurnIntentClassification,
    // P10: only ever supplied by the flag-ON OneLoopPause catch below, which is the only call
    // site with a real "which plan task was RUNNING" answer — the flag-OFF flat/batch loop calls
    // this before any plan task has been selected at all (see runTurn's own call site), so trust
    // mode structurally never applies there (currentTaskId stays undefined, INV-36's match always
    // fails). activePlan defaults to undefined/null rather than being required so that call site
    // doesn't need to thread through a value it doesn't have.
    activePlan?: PlanRecord | null,
    currentTaskId?: string,
  ): Promise<AssistantTurnResult> {
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    if (loopResult.kind === 'needs_approval') {
      classifyAndTraceExecutionMode(this.onTrace, { isPlanCancelBypass: false, isBatchResearch: false, isTrivial: false, requiresApproval: true })
      // dangerouslySkipPermissions auto-applies the staged action the same way a second turn()
      // call with `approved: true` would — resolvePendingAction is exactly that path, just
      // invoked immediately instead of waiting for the caller to resume it.
      if (this.dangerouslySkipPermissions) {
        return this.actionApproval.resolvePendingAction(sessionId, transcriptKey, loopResult.pendingActionId, true, userMessage)
      }
      // INV-36 (plan mode's P10): the one narrow, per-plan opt-in exception to the same rule —
      // auto-apply only a write/shell/email action proposed while executing the specific task
      // that is this trust-approved plan's currently RUNNING one (not any task, not any plan).
      // 'batch' pendingActionKind is excluded — it's a search-cost pacing confirmation, not an
      // ActionApprovalService-style consequential action, and was never in scope for trust mode.
      if (
        loopResult.pendingActionKind !== 'batch' &&
        activePlan?.trustApprovedSteps === true &&
        currentTaskId !== undefined &&
        activePlan.tasks.some((t) => t.id === currentTaskId)
      ) {
        this.onTrace?.({ kind: 'plan_trust_auto_applied', pendingActionKind: loopResult.pendingActionKind, taskId: currentTaskId })
        return this.actionApproval.resolvePendingAction(sessionId, transcriptKey, loopResult.pendingActionId, true, userMessage)
      }
      return {
        status: 'needs_approval',
        reply: null,
        reason: loopResult.reason,
        // A write_file/run_shell_command call is consequential regardless of what the classifier
        // made of the message text — this is a tool-call-level gate, not the message-level one.
        riskLevel: 'HIGH',
        pendingActionId: loopResult.pendingActionId,
        pendingActionKind: loopResult.pendingActionKind,
      }
    }
    this.onTrace?.({ kind: 'escalation', reason: loopResult.reason })
    return { status: 'escalated', reply: null, reason: loopResult.reason, riskLevel: classification.riskLevel }
  }
}
