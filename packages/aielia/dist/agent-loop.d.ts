import { ToolExecutorContext, HarnessPauseSignal, InvestigationRequestData, InvestigationFinding } from '@buildaharness/harness';
import { MemoryAdapter, ILLMClient, ChatMessage, ToolCallResult, TokenUsage, ToolDefinition, ReminderStore } from '@buildaharness/runtime';
import { AssistantSource } from './assistant-source.js';
import { DebugLogEntry } from './debug-log.js';
import { TraceEvent } from './trace-events.js';
import { TurnIntentClassification, RiskLevel } from './turn-intent-classifier.js';
import { evaluateToolPolicy } from './tool-policy.js';
import { TurnControlPlaneState } from './tool-control-plane.js';
import { FileToolsContext } from './file-tools.js';
import { WebToolsContext } from './web-tools.js';
import { ShellToolsContext } from './shell-tools.js';
import { ActionToolsContext } from './action-tools.js';
import { DigestReader } from './recall-tool.js';
import { AssistantToolStep } from './tool-step.js';
import { EscalationPlan } from './layer-policy-wiring.js';
export type ToolLoopResult = {
    kind: 'final';
    content: string;
    sources: AssistantSource[];
    batchBudget?: BatchBudgetTrace;
} | {
    kind: 'needs_approval';
    reason: string;
    pendingActionId: string;
    pendingActionKind: 'write' | 'shell' | 'email' | 'batch';
    resume?: StagedCallResume;
} | {
    kind: 'escalated';
    reason: string;
};
/**
 * Set on a needs_approval result when the pause came from a tool call this loop dispatched itself
 * (a proxy-backend `write_file`/`run_shell_command`/`send_email` call): the exact call the model
 * made, so the loop can be continued once the staged action resolves instead of ending the turn.
 * Absent for a pause whose call lives inside a backend's own agentic loop (claude-cli's
 * `__staged_action`) — there is no message history to continue from.
 */
export interface StagedCallResume {
    toolCall: ToolCallResult;
    assistantContent: string;
}
/**
 * Persisted under `loop-pending:<pendingActionId>` while a flat tool loop waits on an approval, so
 * an approved action's result can be folded back into the same conversation (see
 * AgentLoop.resumeToolLoop). `messages` is everything sent to the model so far, system prompt
 * included, *excluding* the assistant message holding the staged call (rebuilt on resume).
 */
export interface ToolLoopPendingState {
    sessionId: string;
    userMessage: string;
    riskHint: TurnIntentClassification['riskLevel'];
    messages: ChatMessage[];
    sources: AssistantSource[];
    iterationsUsed: number;
    toolCall: ToolCallResult;
    assistantContent: string;
    /** Approved actions already carried out earlier in this same turn (see describeAppliedAction) — recorded in the transcript with the turn's final reply so later turns know what was done. */
    actions?: string[];
}
/** Sent when the model returns an empty final answer, before the one retry. */
/** For a reply that held only a line shaped like the system's action record: the actions it listed were not run, so unlike the blank-reply nudge this one sends the model back to its tools. */
export declare const RECORD_ONLY_REPLY_NUDGE = "Your last reply held only a line shaped like the system's action record, no answer, and the system ran nothing it listed. Do what the user asked now with your tools if it is still wanted, then reply in plain text with what you did and found. Never write a \"Recorded by the system\" line yourself.";
export declare const EMPTY_REPLY_NUDGE = "Your last reply was empty. This check is automatic and is not from the user. Answer the user's message now in plain text: if you did work this turn, say what you did and what you found; if the message needs no work, just answer it. Do not call a tool unless something is still unfinished.";
/** The nudge with the user's message quoted, so the model answers that message and not the nudge (benchmark scenario 12 turn 1: told to "summarize", it answered a summary request the user never made). */
export declare function withUserMessage(nudge: string, userMessage: string): string;
/** Sent when a turn used all its tool steps, before the one tool-less summary call. */
export declare const OUT_OF_STEPS_NUDGE = "You have used all the tool steps available for this turn. Reply now in plain text: say what you did, what worked, and what is still unfinished. Do not call any tool.";
/**
 * The reply used when the model returns nothing twice in a row: built only from what is on record, so the user
 * never gets an empty message. `actions` is the turn's list of carried-out approved actions (see describeAppliedAction).
 */
export declare function fallbackFinalReply(actions: string[] | undefined): string;
export declare const toolLoopPendingKey: (pendingActionId: string) => string;
/**
 * R2 of the internal plan: thrown by a harness-driven proposer
 * (createHarnessProposer, below) when runToolIterationStep produces a 'needs_approval' or
 * 'escalated' ToolLoopResult — the harness's own execute() rethrows anything satisfying
 * isHarnessPauseSignal unexamined (no SYSTEM_ERROR evidence, no task-FAILED transition), so this
 * is never misclassified as a tool failure. Carries the original ToolLoopResult so the eventual
 * catcher (assistant.ts's runTurn, alongside its existing `catch (err) { if (err instanceof
 * EscalationHalt) ... }` branch — see R3) can build the exact same needs_approval/escalated
 * AssistantTurnResult it already builds from a flag-OFF ToolLoopResult, without re-deriving it.
 */
export declare class OneLoopPause extends Error implements HarnessPauseSignal {
    readonly result: Extract<ToolLoopResult, {
        kind: 'needs_approval' | 'escalated';
    }>;
    /**
     * P10 of the internal plan: the plan task (if any) that was RUNNING
     * — i.e. whichever task `execute()` was calling this proposer for — when `result` was
     * produced, threaded from `ToolExecutorContext.currentTaskId`. Lets the catcher
     * (assistant.ts's `buildToolLoopPauseResult`) check INV-36's trust condition without
     * re-deriving "which task was this" from anything else. `undefined` for the batch proposer's
     * own confirmation-gate throw (not a write/shell/email action, so trust mode never applies to
     * it) and for any pre-P10 construction.
     */
    readonly currentTaskId?: string | undefined;
    readonly __harnessPause: true;
    constructor(result: Extract<ToolLoopResult, {
        kind: 'needs_approval' | 'escalated';
    }>, 
    /**
     * P10 of the internal plan: the plan task (if any) that was RUNNING
     * — i.e. whichever task `execute()` was calling this proposer for — when `result` was
     * produced, threaded from `ToolExecutorContext.currentTaskId`. Lets the catcher
     * (assistant.ts's `buildToolLoopPauseResult`) check INV-36's trust condition without
     * re-deriving "which task was this" from anything else. `undefined` for the batch proposer's
     * own confirmation-gate throw (not a write/shell/email action, so trust mode never applies to
     * it) and for any pre-P10 construction.
     */
    currentTaskId?: string | undefined);
}
/** Per-item calibration inputs — see nextItemBudget. */
export interface BatchBudgetState {
    callsPerItemHistory: number[];
    perItemFloor: number;
    slackFactor: number;
    absoluteTurnCeiling: number;
}
/**
 * Drops one min and one max before averaging once there are enough samples for that to be
 * meaningful (fewer than 3 just averages plain) — so a single unusually cheap or expensive item
 * can't swing the projection to either extreme on its own.
 */
export declare function trimmedAverage(counts: number[]): number;
/** Budget for the next item to resolve — floored so a suspiciously cheap item can't starve the
 * rest, with slack headroom on top of the calibrated average. */
export declare function nextItemBudget(state: BatchBudgetState): number;
/**
 * One batch item's outcome from its own per-item sub-loop (see resolveBatchItem). `exhausted`
 * means the sub-loop ran out of its budget without the model producing a final answer for this
 * item. `status` distinguishes *why* a non-'found' outcome happened: 'not_found' covers both the
 * item-scoped dead-end window tripping early (BATCH_DEAD_END_WINDOW consecutive dead_end tool
 * results) and a needs_approval bail-out; 'truncated_while_productive' means the budget ran out
 * while the trailing window was still turning up plausibly-relevant content.
 */
export interface BatchItemResolution {
    item: string;
    content: string;
    callsUsed: number;
    exhausted: boolean;
    status: 'found' | 'not_found' | 'truncated_while_productive';
    sources: AssistantSource[];
}
/**
 * Persisted across the confirmation round trip (see runBatchToolLoop's confirmation gate and
 * ActionApprovalService.resolvePendingBatchConfirmation) so approving resumes with the probe
 * items' real results intact instead of re-probing them, and declining can still return those
 * real results instead of discarding them.
 */
export interface BatchPendingState {
    userMessage: string;
    systemPrompt: string;
    sessionId: string;
    probedResults: BatchItemResolution[];
    remainingItems: string[];
    /** The projection computed at the confirmation gate — carried across the round trip so the
     * resume/decline paths can report the same number in the batch trace instead of re-deriving
     * it (or leaving it absent) after the fact. */
    projectedTotal: number;
}
/**
 * Present only when the batch-research path (batch-list-detector.ts / runBatchToolLoop) drove
 * this turn — absent otherwise, same "absent when unused" convention as sources/usage. Turns
 * `should we raise the ceiling/floor/slack factor` from a guess into a measurement.
 */
export interface BatchBudgetTrace {
    itemCount: number;
    callsPerItemHistory: number[];
    projectedTotal: number;
    totalCallsUsed: number;
    perItemOutcomes: {
        item: string;
        status: 'found' | 'not_found' | 'truncated_while_productive';
        callsUsed: number;
    }[];
}
/** Builds a batch trace from a batch turn's resolved items — shared by runBatchToolLoop's direct
 * path and both resolvePendingBatchConfirmation outcomes (see ActionApprovalService). */
export declare function buildBatchBudgetTrace(itemCount: number, projectedTotal: number, resolutions: BatchItemResolution[]): BatchBudgetTrace;
export declare function looksLikeUnparsedToolCall(content: string): boolean;
export declare class AgentLoop {
    private readonly memory;
    private readonly llmClient;
    private readonly model;
    private readonly fileTools;
    private readonly webTools;
    private readonly shellTools;
    private readonly actionTools;
    private readonly reminderStore;
    private readonly maxSteps;
    private readonly onTrace;
    private readonly onDebugLog;
    constructor(memory: MemoryAdapter, llmClient: ILLMClient, model: () => string | undefined, fileTools: FileToolsContext | undefined, webTools: WebToolsContext | undefined, shellTools: ShellToolsContext | undefined, actionTools: ActionToolsContext | undefined, reminderStore: ReminderStore, maxSteps: number, onTrace: ((event: TraceEvent) => void) | undefined, onDebugLog: ((entry: DebugLogEntry) => void) | undefined);
    /**
     * Phase 4c: builds one fresh, turn-scoped live ControlState (tool-control-plane.ts), seeded
     * with the same tool-name list runToolLoop/resolveBatchItem already build internally — kept
     * here rather than in the sequencer (assistant.ts) so the caller never needs to re-import
     * FILE_TOOLS/WEB_TOOLS/SHELL_TOOLS/REMINDER_TOOLS just to construct this; AgentLoop already
     * privately owns which tools are configured. Call once per turn (when a tool loop will run)
     * and thread the result through runToolLoop/runBatchToolLoop so it's shared across every tool
     * call the turn makes, including across batch items.
     */
    createControlPlaneState(): TurnControlPlaneState;
    /**
     * R2 of the internal plan: builds the real toolExecutors['default']
     * entry HarnessBridge.run() swaps in when the one-loop flag is enabled — a proposer that calls
     * runToolIterationStep once per driveMainLoop iteration and translates its discriminated result
     * into the primitives D0/D1 already built: a plain return (status 'continue', no output yet) for
     * `{ done: false }`, the final answer text for a `{ done: true, result: { kind: 'final' } }`
     * step, or a thrown OneLoopPause for `needs_approval`/`escalated` — never a thrown plain Error,
     * so execute() never misclassifies this as a tool failure.
     *
     * Control-plane state: the proposer holds one real, turn-scoped `TurnControlPlaneState`
     * (`createControlPlaneState`, the exact object the flag-OFF flat path threads through
     * `runToolLoop`) for its whole lifetime — so `runToolIterationStep`'s `recordToolOutcome` has
     * real evidence/worldModel/diagnostics/failureDiagnostics stores to write each dispatched call's
     * outcome into, and same-turn tool-failure-pattern gating behaves identically to flag-OFF. On
     * top of that, the harness's own live per-iteration `toolCtx.controlState` is pinned onto that
     * state at the start of every iteration as the gate's floor (D2's "one composition, not two"
     * intent): a harness DENY / HUMAN_REQUIRED escalation is honored by `checkToolPolicy` before the
     * iteration's first call executes. `recordToolOutcome` re-resolves `.controlState` from the
     * turn-local stores after each recorded outcome — that only ever escalates further (8+ same-turn
     * failures) and `evaluateToolPolicy` ignores `execution_mode`, so it never downgrades a harness
     * escalation that would have mattered.
     */
    createHarnessProposer(input: {
        messages: ChatMessage[];
        tools: ToolDefinition[];
        sessionId: string;
        userMessage: string;
        maxIterations: number;
        sources: AssistantSource[];
        onToken?: (token: string) => void;
        onToolStep?: (step: AssistantToolStep) => void;
        onUsage?: (usage: TokenUsage) => void;
        riskHint?: TurnIntentClassification['riskLevel'];
        /**
         * Mid-turn steering (goalGraphMode): messages the user sent while this turn runs that the
         * scope×urgency classifier judged apply to the answer being produced right now. Called once
         * per iteration, immediately before the LLM call; anything returned is spliced in as a user
         * turn so the model itself applies it — no lexical matching, unlike the harness's
         * caller-constraint output contract.
         */
        takeSteeringNotes?: () => string[];
        /**
         * Plan steps: the instruction to give the model when the harness starts working on `taskId`, or
         * undefined for a task that is just "answer the user's message" (every ordinary turn). Sent once per
         * task; the step's final answer is then kept in the conversation so a later step can build on it.
         */
        stepInstruction?: (taskId: string) => string | undefined;
        /**
         * True while the harness is running several subtasks that all stand for ONE answer to the user's
         * message (an ordinary decomposed turn, not a plan). The first subtask to finish produces the answer;
         * the rest reuse it instead of asking the model the same question again. A task the harness runs a
         * second time (a retry after a rejection) gets a fresh call, never the answer that was rejected.
         */
        shareAnswer?: () => boolean;
    }): (toolCtx: ToolExecutorContext) => Promise<unknown>;
    /**
     * R3 of the internal plan: the wiring-level counterpart to
     * `createHarnessProposer` above — builds the same `messages`/`tools` shape `runToolLoop` builds
     * (system prompt + transcript + user message; whichever of FILE_TOOLS/WEB_TOOLS/SHELL_TOOLS/
     * ACTION_TOOLS/REMINDER_TOOLS are configured) so `assistant.ts`'s `runTurn` doesn't need to
     * duplicate that list-building just to wire the flag-ON path, and caps iterations at
     * `this.maxSteps` — the same cap `runToolLoop` applies — rather than something the caller has to
     * choose. Returns the mutable `sources` array threaded into the proposer so the caller can read
     * back whatever got pushed to it once the harness run using this proposer has finished (mirrors
     * `ToolLoopResult`'s `sources` field on the flag-OFF path).
     */
    createOneLoopProposer(sessionId: string, transcript: ChatMessage[], userMessage: string, systemPrompt: string, onToken?: (token: string) => void, onToolStep?: (step: AssistantToolStep) => void, onUsage?: (usage: TokenUsage) => void, riskHint?: TurnIntentClassification['riskLevel'], takeSteeringNotes?: () => string[], stepInstruction?: (taskId: string) => string | undefined, shareAnswer?: () => boolean): {
        proposer: (toolCtx: ToolExecutorContext) => Promise<unknown>;
        sources: AssistantSource[];
    };
    /**
     * R4 of the internal plan: the batch-research counterpart to
     * `createOneLoopProposer` above — routes `runBatchToolLoop`'s probe → calibrate → confirm-gate
     * → resolve-remaining → synthesize sequence through the same harness-driven proposer mechanism,
     * instead of batch research remaining a second code path that (per R3) never reached the
     * harness regardless of the flag. Reuses `resolveBatchItem`/`resolveRemainingBatchItems`/
     * `synthesizeBatchReply` verbatim — the exact same methods the flag-OFF path calls — so the
     * dead-end window (local `toolYields`, scoped inside `resolveBatchItem`) and the calibrated
     * per-item budget (`resolveRemainingBatchItems`'s own `Budget`/`nextItemBudget` logic) keep
     * bounding a hard item's spend identically; nothing here reimplements that math.
     *
     * The closure advances through three phases, one per `driveMainLoop` iteration (i.e. one
     * `__harnessExecutionStatus: 'continue'` per phase transition) rather than one per underlying
     * tool call the way the flat proposer does: 'probe' (resolve every probe item, calibrate, and
     * either throw a `needs_approval` OneLoopPause — mirroring `runBatchToolLoop`'s own confirmation
     * gate, including persisting the same `BatchPendingState` so the existing, flag-independent
     * `resolvePendingBatchConfirmation` resume path needs no changes — or fall through), 'resolve'
     * (resolve every remaining item in one `resolveRemainingBatchItems` call), and 'synthesize'
     * (stream the final reply via `synthesizeBatchReply`, preserving its existing token-by-token
     * `onToken` semantics, then return `'complete'`). This is coarser-grained resumability than the
     * flat proposer's per-tool-call steps — a deliberate scope decision (see this phase's
     * implementation note) rather than reimplementing `resolveRemainingBatchItems`'s calibration
     * loop one item at a time just to get finer-grained checkpoints.
     */
    createBatchOneLoopProposer(items: string[], sessionId: string, userMessage: string, systemPrompt: string, onToken?: (token: string) => void, onToolStep?: (step: AssistantToolStep) => void, onUsage?: (usage: TokenUsage) => void): {
        proposer: (toolCtx: ToolExecutorContext) => Promise<unknown>;
        sources: AssistantSource[];
        getBatchBudget: () => BatchBudgetTrace | undefined;
    };
    /**
     * Phase 4/4c: the deterministic, harness-state-informed authority for whether `toolName` may
     * proceed — see tool-policy.ts. `controlState` is the live, per-turn ControlState built by
     * tool-control-plane.ts and threaded down from runTurn (see createTurnControlPlaneState);
     * `undefined` at the very first tool call of a turn (nothing recorded yet — the pre-evidence
     * baseline tool-policy.ts's own doc comment describes) or for a caller that never wired one in.
     */
    private checkToolPolicy;
    /**
     * Bounded ReAct loop: calls callChatStructured with whichever of file/web/shell/reminder
     * tools are configured, executing real (non-mutating) tool calls and looping, until
     * either a final text reply comes back, a write_file/run_shell_command call needs
     * staging + approval, or the iteration cap is hit. Only ever invoked when `fileTools`,
     * `webTools`, or `shellTools` is configured (reminder tools ride along whenever any of
     * those does, since `reminderStore` always exists).
     */
    runToolLoop(sessionId: string, transcript: ChatMessage[], userMessage: string, systemPrompt: string, onToken?: (token: string) => void, onToolStep?: (step: AssistantToolStep) => void, onUsage?: (usage: TokenUsage) => void, riskHint?: TurnIntentClassification['riskLevel'], controlPlaneState?: TurnControlPlaneState): Promise<ToolLoopResult>;
    /** One last model call without tools after the step budget ran out; undefined if it fails or returns nothing. */
    private summarizeWhenOutOfSteps;
    /** Replaces an empty final answer (the model returned nothing twice) with fallbackFinalReply, shown through onToken like any answer. */
    private withFallbackReply;
    private flatLoopTools;
    /**
     * When the flat loop pauses on a staged call it dispatched itself, saves what is needed to keep
     * going after the approval (see ToolLoopPendingState) and strips the in-memory `resume` handle
     * from the result the caller sees. Any other result is returned untouched.
     */
    private persistPausedLoop;
    /**
     * Continues a flat tool loop that paused on an approval-gated call, after that call's staged
     * action has been resolved: `toolResultText` (the command's output, a write confirmation, ...)
     * goes back to the model as the tool result for the exact call it made, and the loop runs on —
     * more reads, further approvals (which pause again and persist again), then a final answer —
     * within whatever iteration budget the turn had left.
     */
    resumeToolLoop(state: ToolLoopPendingState, toolResultText: string, onToken?: (token: string) => void, onToolStep?: (step: AssistantToolStep) => void, onUsage?: (usage: TokenUsage) => void, actions?: string[] | undefined): Promise<ToolLoopResult>;
    /**
     * The actual ReAct-style tool-calling loop, factored out of runToolLoop so a batch sub-loop
     * (resolveBatchItem, below) can run the exact same iteration logic — including the
     * looksLikeUnparsedToolCall retry guard and write/shell staging — scoped to its own message
     * history and its own (usually much smaller) iteration budget, instead of duplicating it.
     * `maxIterations` replaces runToolLoop's former direct use of `this.maxSteps`; passing
     * `this.maxSteps` here reproduces that method's exact prior behavior unchanged.
     *
     * `onToolResult`, when provided, is called after every tool result is folded into `messages`
     * and may return `'stop'` to end the loop immediately (see resolveBatchItem's item-scoped
     * dead-end window) — a caller that never passes it (runToolLoop, the flat non-batch path)
     * gets today's unmodified behavior: the loop only ever ends via a final answer, an
     * needs_approval bail-out, or maxIterations.
     *
     * Thin wrapper (R1 of the D2 one-loop-rewire follow-up plan) around
     * `runToolIterationStep`, which does one iteration's worth of work and returns a discriminated
     * `done`/`not done` result — the shape a harness-driven `driveMainLoop` can call once per its
     * own iteration (R2), instead of only ever being driven by this method's own `for` loop.
     */
    private runToolIterations;
    /**
     * One iteration's worth of `runToolIterations`' ReAct loop, extracted (R1 of the D2
     * one-loop-rewire follow-up plan, the internal plan) so a
     * harness-driven proposer (R2) can call this directly, once per `driveMainLoop` iteration,
     * instead of only ever being driven by `runToolIterations`' own `for` loop. Preserves every
     * early-return branch of the original loop body exactly — the unparsed-tool-call retry,
     * `__staged_action` adoption, write/shell/email staging, cached-shell replay, per-call
     * `tool-policy.ts` DENY/REQUIRE_APPROVAL, and the `onToolResult` dead-end-window stop — as a
     * `{ done: true, result }` return; the two cases that used to `continue` the outer `for` loop
     * (the unparsed-tool-call retry and a cached-shell replay) become `{ done: false, ... }`
     * instead, with `dispatchedAnyToolCall` threaded back to the caller since it must persist
     * across iterations. `sources` is mutated in place (pushed to) rather than threaded through
     * the result, since it's a plain accumulator shared by reference across every step call for
     * the same loop.
     */
    /**
     * The tool error for a write_file over an existing file the session has not read, or undefined when the write may go ahead (a new
     * file, or one this session read or wrote). Benchmark scenario 13 turn 4: after a turn with no tool call at all, the model answered
     * "fix that too" with a write_file that replaced `calculate_priority` with an invented function of a different signature, never having
     * read the file. A write is a full replacement, so it has to be based on what the file really holds.
     */
    private unreadExistingFile;
    private runToolIterationStep;
    /**
     * A staging call (write_file / run_shell_command / send_email) was rejected before anything was staged — a path or
     * cwd outside the workspace, a malformed recipient. The tool descriptions promise "rejected immediately": that is a
     * tool error the model sees and can correct, exactly like a failed read, not an exception that ends the turn.
     * Every tool call in the response gets a result (the provider requires one per call id).
     */
    private stagingRejected;
    /**
     * Resolves one batch item in its own bounded sub-loop — structurally the same
     * runToolIterations call the flat loop uses, just seeded with a single-item-focused user
     * message and a per-item budget instead of the whole conversation and `this.maxSteps`.
     *
     * The dead-end window (`toolYields`) is a local array, created fresh on every call to this
     * method — never shared across items: a hard item that trips BATCH_DEAD_END_WINDOW
     * consecutive dead_end results only stops *this* item's sub-loop early (rather than spending
     * the rest of its budget on a dead page) and can never poison an easier item queued behind it.
     */
    private resolveBatchItem;
    /**
     * Resolves every item in `remainingItems` in its own sub-loop, recalibrating the per-item
     * budget after each one via nextItemBudget instead of freezing it at the initial probe
     * average, and stopping once the running total hits BATCH_ABSOLUTE_TURN_CEILING regardless of
     * how favorable calibration still looks. Returns every resolution so far (probed + newly
     * resolved) plus the names of any items never attempted because the ceiling was hit first.
     * Public — also called by ActionApprovalService.resolvePendingBatchConfirmation on the
     * approved-continuation path.
     */
    resolveRemainingBatchItems(probedResults: BatchItemResolution[], remainingItems: string[], systemPrompt: string, sessionId: string, onToolStep?: (step: AssistantToolStep) => void, onUsage?: (usage: TokenUsage) => void, controlPlaneState?: TurnControlPlaneState): Promise<{
        resolutions: BatchItemResolution[];
        notAttempted: string[];
    }>;
    /**
     * Synthesizes one final reply from every item's per-item findings — same shape as the flat
     * loop's own final-answer call, just seeded with structured per-item results instead of raw
     * tool-call history for every item at once.
     *
     * Any item in `notAttempted` (the absolute ceiling was hit before it was ever reached) is
     * appended as a deterministic, guaranteed-present list rather than left to the synthesis
     * call's prose — an LLM asked to "write one well-organized reply" over many items can drop one
     * from its summary the same way it can drop one from a longer todo list; the per-item
     * `resolutions` themselves stay inside the model's synthesis (their found/not_found/
     * truncated_while_productive wording is already baked into `content` by resolveBatchItem, so
     * the model has no need to invent that part), but which items were never even attempted this
     * turn is a plain fact, not something worth trusting to how well the model followed
     * instructions. Public — also called by ActionApprovalService.
     */
    synthesizeBatchReply(userMessage: string, systemPrompt: string, resolutions: BatchItemResolution[], notAttempted: string[], onToken?: (token: string) => void, onUsage?: (usage: TokenUsage) => void): Promise<string>;
    /**
     * Gated entry point for the batch-research path: probes the first 1-2 items (keeping at least
     * one item unprobed so a single sample can't swing the whole projection), calibrates a
     * per-item budget off their real cost, and either pauses for confirmation (a large projection)
     * or resolves every remaining item and synthesizes the final reply.
     */
    runBatchToolLoop(items: string[], sessionId: string, userMessage: string, systemPrompt: string, onToken?: (token: string) => void, onToolStep?: (step: AssistantToolStep) => void, onUsage?: (usage: TokenUsage) => void, controlPlaneState?: TurnControlPlaneState): Promise<ToolLoopResult>;
    /**
     * Dispatches one tool call by name to its executor. web_search/fetch_url results
     * are wrapped as untrusted external content (and flagged if they look like an
     * injection attempt) before they ever reach the model — file and reminder results
     * are not, since they're the assistant's own workspace/state, not adversarial input.
     */
    /** AL8b: optional policy gate for LLM injection detection; `undefined` (default) ⇒ always detect. */
    injectionDetectionGate?: () => boolean;
    /** Episodic digest source for `recall_memory` (M3); set by the assistant. The tool is offered only when this is set AND AUDIT_RECALL_TOOL is on. */
    digestReader?: DigestReader;
    /**
     * Set by the assistant: whether this session has already read (or itself written) a workspace file. A write over an existing file
     * that the session never read is refused (see unreadExistingFile), so the model cannot replace a file with contents it guessed.
     */
    sessionKnowsFile?: (sessionId: string, workspaceRelativePath: string) => boolean;
    private recallTools;
    /** The opt-in layers' plan for the turn in flight (adaptive mode only), set by the assistant each turn; see resolveOptInPlan. */
    optInPlan?: EscalationPlan;
    private executeToolCall;
    /**
     * Trajectory Supervisor GATHER_EVIDENCE host (S5 of
     * the internal plan). A bounded, strictly read-only tool
     * loop the harness calls (via HarnessRunOptions.runInvestigation) when the supervisor
     * decides the run is stuck for lack of a fact.
     *
     * - Read-only only: suggested_tools is filtered through validateInvestigationTools()
     *   (INV-23) and then further to the subset this loop knows how to invoke from just a
     *   question string. write_file / run_shell_command / send_email are never in the
     *   allowlist and executeToolCall() has no branch for them here — no __staged_action
     *   path is reachable.
     * - Its own Budget (INV-25), independent of the turn's batch ceiling: maxCalls =
     *   min(req.budget, allowed tools). Exhaustion returns whatever was found.
     * - Every call is gated by the same evaluateToolPolicy() the manual dispatch loop uses;
     *   a DENY / REQUIRE_APPROVAL skips that tool (an investigation never prompts).
     * - Faults are isolated: a throwing / empty tool call is skipped, never propagated.
     */
    runSupervisorInvestigation(req: InvestigationRequestData, opts?: {
        riskHint: RiskLevel;
        controlState?: Parameters<typeof evaluateToolPolicy>[0]['controlState'];
    }): Promise<InvestigationFinding[]>;
}
