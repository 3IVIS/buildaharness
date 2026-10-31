import { EscalationHalt, HarnessCheckpoint, VerificationResult, LayerActivityEvent, HarnessRunResult } from '@buildaharness/harness';
import { MemoryAdapter, TokenUsage } from '@buildaharness/runtime';
import { GroundingResult } from './grounding-check.js';
import { TurnIntentClassification } from './turn-intent-classifier.js';
import { PlanRecord } from './plan-store.js';
import { PlanService } from './plan-service.js';
import { GoalThread, ThreadSuggestion } from './goal-graph-store.js';
import { AssistantSession } from './assistant-session.js';
import { MemoryService } from './memory-service.js';
import { AssistantSource } from './assistant-source.js';
import { BatchBudgetTrace } from './agent-loop.js';
import { AssistantTurnResult } from './assistant-types.js';
import { TraceEvent } from './trace-events.js';
/**
 * AssistantTurnResult assembly for every return path — the triviality fast path, the
 * plan-pacing pause, the harness success path, and the EscalationHalt-caught path — split out of
 * runTurn in Phase 4d of the architecture remediation plan. Each method persists whatever this
 * path needs to persist (transcript, facts, plan) and returns the final result, so the sequencer
 * (assistant.ts) never has to duplicate per-path assembly logic.
 */
export declare class ResponseService {
    private readonly memoryService;
    private readonly session;
    private readonly planService;
    private readonly onTrace;
    private readonly memory?;
    private readonly nextStepProposer?;
    private readonly groundingChecker?;
    constructor(memoryService: MemoryService, session: AssistantSession, planService: PlanService, onTrace: ((event: TraceEvent) => void) | undefined, memory?: MemoryAdapter | undefined, nextStepProposer?: ((thread: GoalThread, onUsage: ((usage: TokenUsage) => void) | undefined, sessionId: string) => Promise<ThreadSuggestion[]>) | undefined, groundingChecker?: ((input: {
        question: string;
        reply: string;
        sources: AssistantSource[] | undefined;
    }, onUsage: ((usage: TokenUsage) => void) | undefined) => Promise<GroundingResult>) | undefined);
    /**
     * INV-42's concrete mechanism: mirrors the `activePlan`-based `saveAndSummarize` sync just
     * above/below each call site, but onto `threadId`'s own `GoalThread.tasks` via
     * `syncThreadFromTaskGraph` — looked up **by id**, not by `getActiveThread`, so this still
     * lands the run's evidence on a thread the Scheduler has since moved to `PAUSED` (an in-flight
     * tool call that was already running when a steering message preempted its thread runs to
     * completion per Q3's "let it finish" default, and its result must still reach the now-PAUSED
     * thread, not be silently dropped). A no-op when `memory` wasn't wired in, or the caller never
     * resolved a `threadId` — exactly today's behavior either way (INV-43).
     */
    /** Public entry for the tool-level approval path (a staged write/command pauses the turn before any result builder runs): records the tasks on the goal thread so Goals shows them. */
    syncGoalThread(sessionId: string, threadId: string | undefined, tasks: {
        id: string;
        status: string;
        description?: string;
        depends_on?: string[];
        risk_level?: string;
    }[], onUsage?: (usage: TokenUsage) => void): Promise<void>;
    /** Marks every counted task of `threadId` COMPLETE (the staged actions it was waiting on were approved and applied); a thread whose tasks all finish moves to DONE. */
    completeGoalThread(sessionId: string, threadId: string | undefined, onUsage?: (usage: TokenUsage) => void): Promise<void>;
    private syncGoalThreadEvidence;
    buildTrivialResult(params: {
        sessionId: string;
        transcriptKey: string;
        userMessage: string;
        draftReply: string;
        classification: TurnIntentClassification;
        sources: AssistantSource[] | undefined;
        batchBudgetTrace: BatchBudgetTrace | undefined;
        usageTotal: TokenUsage | undefined;
        onUsage?: (usage: TokenUsage) => void;
    }): Promise<AssistantTurnResult>;
    buildPausedResult(params: {
        sessionId: string;
        transcriptKey: string;
        userMessage: string;
        draftReply: string;
        classification: TurnIntentClassification;
        activePlan: PlanRecord | null;
        checkpoint: HarnessCheckpoint;
        lastVerification: VerificationResult | null;
        layerActivity: LayerActivityEvent[];
        sources: AssistantSource[] | undefined;
        batchBudgetTrace: BatchBudgetTrace | undefined;
        usageTotal: TokenUsage | undefined;
        onUsage?: (usage: TokenUsage) => void;
        goalThreadId?: string;
        /** Task id → why the completion check judged it not done, from this run; persisted on the plan. */
        taskNotes?: Record<string, string>;
    }): Promise<AssistantTurnResult>;
    buildSuccessResult(params: {
        sessionId: string;
        transcriptKey: string;
        userMessage: string;
        draftReply: string;
        classification: TurnIntentClassification;
        activePlan: PlanRecord | null;
        result: HarnessRunResult;
        lastVerification: VerificationResult | null;
        layerActivity: LayerActivityEvent[];
        sources: AssistantSource[] | undefined;
        batchBudgetTrace: BatchBudgetTrace | undefined;
        usageTotal: TokenUsage | undefined;
        onUsage?: (usage: TokenUsage) => void;
        goalThreadId?: string;
        /** Task id → why the completion check judged it not done, from this run; persisted on the plan. */
        taskNotes?: Record<string, string>;
    }): Promise<AssistantTurnResult>;
    buildEscalatedResult(params: {
        sessionId: string;
        transcriptKey: string;
        userMessage: string;
        err: EscalationHalt;
        classification: TurnIntentClassification;
    }): Promise<AssistantTurnResult>;
}
