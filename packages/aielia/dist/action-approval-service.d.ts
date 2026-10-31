import { ILLMClient, MemoryAdapter } from '@buildaharness/runtime';
import { FileToolsContext } from './file-tools.js';
import { ShellToolsContext } from './shell-tools.js';
import { ActionToolsContext } from './action-tools.js';
import { AssistantTurnResult } from './assistant-types.js';
import { AssistantSession } from './assistant-session.js';
import { AgentLoop, ToolLoopResult } from './agent-loop.js';
import { AssistantToolStep } from './tool-step.js';
import { TraceEvent } from './trace-events.js';
import { DebugLogEntry } from './debug-log.js';
/**
 * Optional hooks for resuming a staged action that a flat tool loop paused on (see
 * AgentLoop.resumeToolLoop): the live token/tool-step callbacks of the turn being resumed, and how
 * to turn a *further* pause (another approval, or an escalation) into the turn result — the caller
 * owns that because auto-approve modes live there, not here.
 */
export interface ResumeOptions {
    onToken?: (token: string) => void;
    onToolStep?: (step: AssistantToolStep) => void;
    handleLoopPause?: (result: Extract<ToolLoopResult, {
        kind: 'needs_approval' | 'escalated';
    }>) => Promise<AssistantTurnResult>;
}
export { actionRecordSuffix } from './action-record.js';
/**
 * Owns the "approval-by-ID" pattern: a staged write/shell/revert/batch-research action resolved
 * by ID, never re-derived from a second LLM call (see T4 of the file-tools plan). Split out in
 * Phase 4d of the architecture remediation plan — do not change this behavior when relocating it,
 * only where the code lives.
 */
export declare class ActionApprovalService {
    private readonly memory;
    private readonly llmClient;
    private readonly model;
    private readonly fileTools;
    private readonly shellTools;
    private readonly actionTools;
    private readonly session;
    private readonly agentLoop;
    private readonly onTrace;
    private readonly onDebugLog;
    constructor(memory: MemoryAdapter, llmClient: ILLMClient, model: () => string | undefined, fileTools: FileToolsContext | undefined, shellTools: ShellToolsContext | undefined, actionTools: ActionToolsContext | undefined, session: AssistantSession, agentLoop: AgentLoop, onTrace: ((event: TraceEvent) => void) | undefined, onDebugLog: ((entry: DebugLogEntry) => void) | undefined);
    /** Every write, command and email carried out through an approval, in order (a turn's slice is what the system recorded for it). */
    readonly appliedActions: string[];
    /** Parallel to appliedActions (same indices): for a write, the lines it changed as a short diff, so the reply audit can tell whether a reply's account of the file is true (W1); the same clause as appliedActions for every other kind. */
    readonly appliedActionDetails: string[];
    /** The command and the start/end of the output of each shell command run through an approval (for the reply audit). */
    readonly recentCommandOutputs: {
        command: string;
        output: string;
    }[];
    /** Sessions in which a command got the network-containment refusal. */
    private readonly networkDeniedSessions;
    /** Per session: where in appliedActions the actions of the request now being approved begin (see resolvePendingActionOnce). */
    private readonly chainStartBySession;
    /** Pending-action ids currently being resolved (see resolvePendingAction). */
    private readonly inFlightResolutions;
    networkDenied(sessionId: string): boolean;
    /** Resumes a staged action by ID instead of re-deriving *what to run* from a second LLM call — see T4 of the file-tools plan. `userMessage` is only used to synthesize an answer from a shell command's real output (see below); the command/content actually applied always comes from the staged record, never from a fresh model call. */
    resolvePendingAction(sessionId: string, transcriptKey: string, pendingActionId: string, approved: boolean, userMessage: string, resume?: ResumeOptions): Promise<AssistantTurnResult>;
    private resolvePendingActionOnce;
    /** The conversation before the current user message, for the no-tools synthesis call. The current message was already appended to the transcript when the turn paused, so it is dropped here. */
    private recentHistory;
    /**
     * After resolvePendingAction resolves one staged action (approved or declined), checks whether
     * it was chained to a second approval-gated action staged from the same originating turn (see
     * file-tools-mcp-server.mjs's stagePendingAction doc comment — e.g. a single "run X AND write
     * Y" request). Without this, the second action sat in `.pending-actions/` forever: never
     * surfaced for approval, never executed, never even mentioned as still pending.
     * `previousOutcome` (the reply text already computed for the just-resolved action) is folded
     * into the next prompt's `reason` so cli.ts's recursive needs_approval → handleTurn flow reads
     * as one continuous exchange rather than jumping straight to an unexplained second question.
     * Returns undefined if the linked record is missing or of a kind that's never legitimately
     * chained ('revert', staged only by /undo-action, alone) — a broken link must never crash the
     * turn, just stop chaining and fall back to the caller's own `status: 'ok'`.
     */
    private loadChainedApproval;
    /**
     * Resolves a batch confirmation pause (see AgentLoop.runBatchToolLoop's confirmation gate)
     * once the caller resumes via `turn(message, { approved, pendingActionId })`. Declining
     * resolves the turn immediately with only the probed items' real results, explicitly listing
     * every unprobed item as not attempted. Approving continues resolving the remaining items with
     * zero re-probing — the probe results loaded from `batchState` are reused as-is.
     */
    private resolvePendingBatchConfirmation;
}
