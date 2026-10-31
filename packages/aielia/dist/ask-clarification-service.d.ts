import { AskQuestion, AskResponse } from '@buildaharness/harness';
import { MemoryAdapter } from '@buildaharness/runtime';
import { AssistantSession } from './assistant-session.js';
import { HarnessBridge } from './harness-bridge.js';
import { ResponseService } from './response-service.js';
import { PlanRecord } from './plan-store.js';
import { TurnIntentClassification } from './turn-intent-classifier.js';
import { UserFact } from './fact-extraction.js';
import { AssistantTurnResult } from './assistant-types.js';
import { TraceEvent } from './trace-events.js';
/**
 * Everything AskClarificationService.resolvePendingClarification needs to re-drive the harness
 * run once the user answers — persisted alongside the staged questions themselves (mirrors
 * AgentLoop's BatchPendingState, staged the same `memory.set('ask-pending:${id}', ...)` way, see
 * ActionApprovalService's own "resolved by ID, never re-derived from a second LLM call"
 * discipline this mirrors, T4 of the file-tools plan).
 */
export interface AskClarificationPendingState {
    sessionId: string;
    questions: AskQuestion[];
    classification: TurnIntentClassification;
    activePlan: PlanRecord | null;
    facts: UserFact[];
    draftReply: string;
}
/**
 * Owns the ask-question "staged clarification, resolved by ID" pattern — Q2 of
 * the internal plan, structurally mirroring ActionApprovalService (T4 of
 * the file-tools plan: what gets resolved is exactly what was staged, never re-derived from a
 * second LLM call). Unlike a write/shell action, resolving a clarification means resuming a
 * *harness run* — the checkpoint HarnessBridge would otherwise have deleted on any thrown
 * EscalationHalt (see HarnessBridge.run()'s askModeEnabled/preserveForClarification handling) is
 * kept alive specifically so this service can hand it back to HarnessBridge with the user's
 * answer folded in via a one-shot UpdateChannel, instead of losing the run's progress and
 * starting over.
 */
export declare class AskClarificationService {
    private readonly memory;
    private readonly session;
    private readonly harnessBridge;
    private readonly responseService;
    private readonly onTrace;
    constructor(memory: MemoryAdapter, session: AssistantSession, harnessBridge: HarnessBridge, responseService: ResponseService, onTrace: ((event: TraceEvent) => void) | undefined);
    private pendingKey;
    /**
     * Stages a batch of questions and returns the `needs_clarification` AssistantTurnResult — the
     * ResponseService.buildEscalatedResult counterpart for a structured-question escalation
     * (called instead of it, from assistant.ts's EscalationHalt catch, when
     * `err.blocker.questions` is populated and the effective askMode is enabled).
     */
    stageAndRespond(params: {
        sessionId: string;
        transcriptKey: string;
        userMessage: string;
        questions: AskQuestion[];
        classification: TurnIntentClassification;
        activePlan: PlanRecord | null;
        facts: UserFact[];
        draftReply: string;
    }): Promise<AssistantTurnResult>;
    /**
     * Resolves a staged clarification by ID — validates the response against exactly the
     * questions that were staged (INV-28: a malformed/incomplete payload is rejected, never
     * silently coerced), folds the answer into the paused harness run via a one-shot
     * UpdateChannel, and resumes it. A follow-up escalation (INV-37's deferred batch two) routes
     * back through `stageAndRespond` exactly like the first, via the same catch this resume goes
     * through.
     */
    resolvePendingClarification(sessionId: string, transcriptKey: string, pendingClarificationId: string, response: AskResponse | undefined, askModeEnabled: boolean, 
    /**
     * True when tool turns run through the one-loop proposer (the default). A resumed harness run has NO proposer, so it
     * could only return the stored draft reply — empty for a tool turn, which is what the user got — and the answer,
     * fed into the constraint pipeline, is never read by the proposer's model. In that mode the validated answer is
     * handed to the ordinary turn pipeline instead (`{ fallThrough: true }`, the same shape a plan approval uses), and
     * the paused run is discarded.
     */
    handOffToOrdinaryTurn?: boolean): Promise<AssistantTurnResult | {
        fallThrough: true;
        answerText: string;
    }>;
}
