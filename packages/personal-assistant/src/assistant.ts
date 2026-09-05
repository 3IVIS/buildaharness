import { EscalationHalt, InMemoryExperienceStore, type ExperienceStore, type CheckpointStore, type ToolExecutorContext } from '@buildaharness/harness'
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

import { MemoryService, type MemorySummary, type MemoryExport } from './memory-service.js'
import { AssistantSession, type IndexedMessage, type TranscriptSearchHit } from './assistant-session.js'
import { AgentLoop, OneLoopPause, type BatchBudgetState, type BatchBudgetTrace, type ToolLoopResult, trimmedAverage, nextItemBudget } from './agent-loop.js'
import type { TurnIntentClassification } from './turn-intent-classifier.js'
import { ActionApprovalService } from './action-approval-service.js'
import { PlanService } from './plan-service.js'
import { TurnInterpreter } from './turn-interpreter.js'
import { HarnessBridge } from './harness-bridge.js'
import { DEFAULT_ONE_LOOP_MODE, type OneLoopMode } from './one-loop-flag.js'
import { ResponseService } from './response-service.js'
import type { AssistantSource } from './assistant-source.js'
import type { DebugLogEntry } from './debug-log.js'
import type { AssistantTrace, AssistantTurnResult, AssistantProgress } from './assistant-types.js'

// Re-exported for full backward compatibility — every one of these used to be defined directly
// in this file; they now live in the module that owns their logic (see each module's own doc
// comment), and this file re-exports them under their original names so existing imports from
// './assistant.js' (index.ts, cli.ts, cli-session.ts, assistant.test.ts) keep working unchanged.
export type { MemorySummary, MemoryExport } from './memory-service.js'
export type { IndexedMessage, TranscriptSearchHit } from './assistant-session.js'
export type { BatchBudgetState } from './agent-loop.js'
export { trimmedAverage, nextItemBudget } from './agent-loop.js'
export type { AssistantSource } from './assistant-source.js'
export type { DebugLogEntry } from './debug-log.js'
export type { AssistantTrace, AssistantTurnResult, AssistantProgress } from './assistant-types.js'

const isBrowser = (): boolean => typeof indexedDB !== 'undefined'

export interface TurnOptions {
  sessionId?: string
  approved?: boolean
  pendingActionId?: string
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
}

export interface PersonalAssistantOptions {
  llmClient: ILLMClient
  model?: string
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
   * R2 of plans/harness_d2_one_loop_rewire_plan.html — see one-loop-flag.ts's doc comment for the
   * full rollout rationale. 'disabled' (the default, for the whole R2-R4 rollout window): today's
   * behavior, byte-for-byte — HarnessBridge.run() always uses `() => draftReply` as its toolFn,
   * regardless of whether a caller happens to supply a proposer. 'enabled' lets a supplied
   * proposer (see HarnessRunParams.oneLoopProposer) actually be used. PersonalAssistant itself
   * never touches process.env — only cli.ts (or an equivalent surface entry point) is expected to
   * call resolveOneLoopMode(process.env) and pass the result here.
   */
  oneLoopMode?: OneLoopMode
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
  private readonly memory: MemoryAdapter
  private readonly webTools?: WebToolsContext
  private readonly onTrace?: (event: TraceEvent) => void
  private readonly onDebugLog?: (entry: DebugLogEntry) => void
  private readonly dangerouslySkipPermissions: boolean
  /** Whenever any of fileTools/webTools/shellTools is configured, `turn()` routes through AgentLoop instead of a single plain chat call — computed once here since it never changes for the lifetime of an instance. */
  private readonly toolLoopWillRun: boolean
  /** R3 of plans/harness_d2_one_loop_rewire_plan.html — mirrors the same flag HarnessBridge was given at construction, kept here too so runTurn can decide whether to defer the tool loop into a harness-driven proposer instead of precomputing draftReply. See PersonalAssistantOptions.oneLoopMode's doc comment. */
  private readonly oneLoopMode: OneLoopMode

  private readonly memoryService: MemoryService
  private readonly session: AssistantSession
  private readonly agentLoop: AgentLoop
  private readonly actionApproval: ActionApprovalService
  private readonly planService: PlanService
  private readonly turnInterpreter: TurnInterpreter
  private readonly harnessBridge: HarnessBridge
  private readonly responseService: ResponseService

  constructor(options: PersonalAssistantOptions) {
    this.llmClient = options.llmClient
    this.model = options.model
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

    // Threaded as a getter closure — never a captured string — into every collaborator that
    // reads the current model, so `setModel()` (the `/model` command) keeps working for all of
    // them mid-session instead of freezing whichever model was set at construction time.
    const model = (): string | undefined => this.model

    this.memoryService = new MemoryService(this.memory, reminderStore, experienceStore)
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
    this.planService = new PlanService(this.memory)
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
    )
    this.turnInterpreter = new TurnInterpreter(this.llmClient, model, this.planService, reminderStore)
    this.harnessBridge = new HarnessBridge(
      this.memory, experienceStore, checkpointStore, this.llmClient, model, maxSteps,
      this.planService, this.session, this.onTrace, this.oneLoopMode,
    )
    this.responseService = new ResponseService(this.memoryService, this.session, this.planService, this.onTrace)

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
   * Thin wrapper around runTurn(): emits turn_start/turn_end/error trace events
   * around the actual logic, so every one of runTurn's return paths gets a
   * matching turn_end without instrumenting each one individually.
   */
  async turn(userMessage: string, options: TurnOptions = {}): Promise<AssistantTurnResult> {
    const sessionId = options.sessionId ?? 'default'
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
        return { status: 'escalated', reply: null, reason: check.reason }
      }
    }

    try {
      const result = await this.runTurn(userMessage, options, sessionId)
      if (result.status === 'ok') await this.session.recordSpend(sessionId, result.usage)
      this.onTrace?.({ kind: 'turn_end', sessionId, status: result.status })
      this.onDebugLog?.({
        kind: 'assistant_reply',
        sessionId,
        content: `[${result.status}]${result.riskLevel ? ` (${result.riskLevel})` : ''} ${result.reply ?? result.reason ?? '(no reply)'}`,
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

  /** Ranked search over the per-message index — see AssistantSession.searchTranscript's doc comment. Used by `/search`. */
  async searchTranscript(query: string, topK = 10): Promise<TranscriptSearchHit[]> {
    return this.session.searchTranscript(query, topK)
  }

  /** Changes the model used by every subsequent `turn()` call, mid-session — no reconstruction needed. Used by `/model`. Every collaborator constructed above reads this field through a getter closure, never a captured string, so this takes effect for all of them immediately. */
  setModel(model: string | undefined): void {
    this.model = model
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
      }
    }

    // A staged action is resumed by ID, not re-derived from a second LLM call — see T4 in
    // plans/personal_assistant_file_tools_plan.html for why a second call has no guarantee of
    // proposing identical content (and, for a shell command, no guarantee of proposing the same
    // command at all).
    if (options.pendingActionId) {
      return this.actionApproval.resolvePendingAction(sessionId, transcriptKey, options.pendingActionId, options.approved ?? false, userMessage)
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

    let draftReply: string
    let sources: AssistantSource[] | undefined
    // Set only when the batch-research path (AgentLoop.runBatchToolLoop) drove this turn —
    // carried into every trace built below so AssistantTrace.batchBudget stays populated even
    // though the batch loop itself finishes long before the harness run that ultimately builds
    // `trace`.
    let batchBudgetTrace: BatchBudgetTrace | undefined
    // R3 of plans/harness_d2_one_loop_rewire_plan.html: set only on the flag-ON, non-batch,
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
      // flag is enabled; R4 (plans/harness_d2_one_loop_rewire_plan.html) does the same for batch
      // research, via AgentLoop.createBatchOneLoopProposer — so `!batch` no longer excludes a
      // turn from useOneLoop. A trivial turn still returns below without ever calling
      // harnessBridge.run() (see classification.isTrivial below) — there is no harness run to
      // defer the tool loop into, so it keeps resolving synchronously here too, same as flag-OFF.
      const useOneLoop = this.oneLoopMode === 'enabled' && !classification.isTrivial

      if (useOneLoop && batch) {
        const built = this.agentLoop.createBatchOneLoopProposer(
          batch.items, sessionId, userMessage, systemPrompt, options.onToken, options.onToolStep, accumulateUsage,
        )
        oneLoopProposer = built.proposer
        oneLoopSources = built.sources
        oneLoopBatchBudget = built.getBatchBudget
        draftReply = ''
      } else if (useOneLoop) {
        const built = this.agentLoop.createOneLoopProposer(
          sessionId, transcript, userMessage, systemPrompt, options.onToken, options.onToolStep, accumulateUsage, classification.riskLevel,
        )
        oneLoopProposer = built.proposer
        oneLoopSources = built.sources
        draftReply = ''
      } else {
        // Phase 4c: one live ControlState per turn, shared across every tool call this turn
        // makes — including across batch items (see AgentLoop.createControlPlaneState /
        // tool-control-plane.ts) — so a failure pattern discovered partway through the turn can
        // actually gate a later call via checkToolPolicy. Only needed on this branch: the
        // harness-driven proposer above folds in the harness's own live ControlState instead
        // (see createHarnessProposer's doc comment) rather than this separate structure.
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
      return this.responseService.buildTrivialResult({ sessionId, transcriptKey, userMessage, draftReply, classification, sources, batchBudgetTrace, usageTotal })
    }

    // A compound-looking request decomposes into multiple tasks, and/or an active/matched
    // durable plan drives this turn's task graph instead — see TurnInterpreter.resolveTasks.
    const { initialTasks, activePlan, planClassifiedTrace } =
      await this.turnInterpreter.resolveTasks({ userMessage, sessionId, classification, planForCancelCheck, onUsage: accumulateUsage })
    if (planClassifiedTrace) {
      this.onTrace?.({ kind: 'plan_classified', isCandidate: planClassifiedTrace.isCandidate, matchedTemplate: planClassifiedTrace.matchedTemplate })
    }

    try {
      const outcome = await this.harnessBridge.run({
        sessionId,
        userMessage,
        facts,
        draftReply,
        classification,
        initialTasks,
        activePlan,
        sources,
        onProgress: options.onProgress,
        onUsage: accumulateUsage,
        oneLoopProposer,
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
      })
    } catch (err) {
      if (err instanceof EscalationHalt) {
        return this.responseService.buildEscalatedResult({ sessionId, transcriptKey, userMessage, err, classification })
      }
      // R3 of plans/harness_d2_one_loop_rewire_plan.html: the harness-driven proposer's
      // counterpart to the flag-OFF loopResult.kind === 'needs_approval'/'escalated' branches
      // above — execute.ts rethrows a HarnessPauseSignal (which OneLoopPause implements)
      // unexamined, so it propagates out of harnessBridge.run() as a thrown error rather than a
      // `{ status: 'paused' }` outcome; caught here instead.
      if (err instanceof OneLoopPause) {
        return this.buildToolLoopPauseResult(sessionId, transcriptKey, userMessage, err.result, classification)
      }
      throw err
    }
  }

  /**
   * Shared by the flag-OFF flat/batch tool loop's own needs_approval/escalated ToolLoopResult and
   * the flag-ON harness-driven proposer's equivalent OneLoopPause (R3 of
   * plans/harness_d2_one_loop_rewire_plan.html, see runTurn's two call sites) — "the model wants
   * to write/run/send something" or "the tool loop gave up" means the same thing to the caller
   * regardless of which loop discovered it.
   */
  private async buildToolLoopPauseResult(
    sessionId: string,
    transcriptKey: string,
    userMessage: string,
    loopResult: Extract<ToolLoopResult, { kind: 'needs_approval' | 'escalated' }>,
    classification: TurnIntentClassification,
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
