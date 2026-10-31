import { ILLMClient, TokenUsage, MemoryAdapter } from '@buildaharness/runtime';
import { AskResponse } from '@buildaharness/harness';
import { AssistantSession } from './assistant-session.js';
import { PlanService } from './plan-service.js';
import { PlanApprovalService } from './plan-approval-service.js';
import { AssistantTurnResult } from './assistant-types.js';
import { TraceEvent } from './trace-events.js';
import { AgentLoop } from './agent-loop.js';
/**
 * `{ fallThrough: true }` only ever comes from a *fresh, auto-triggered* entry (`seed` set —
 * assistant.ts's P3 auto-trigger, never PersonalAssistant.enterPlanMode's manual/test entry point)
 * whose very first drafting call failed (malformed/insufficient LLM output, or a thrown error —
 * draftPlanRevision's own try/catch already normalizes both to `null`) — this phase's Validation
 * requires falling back to *not entering plan mode at all* rather than staging a broken draft or
 * getting the user stuck in a "couldn't update the draft" loop they never asked to enter (same
 * "null means fall through" convention `buildPlanFromTemplate` already used). Mirrors
 * `PlanApprovalOutcome`'s exact shape/discipline. A manual `enterPlanMode` entry with no `seed`
 * keeps today's pre-P3 behavior on a failed first draft: stay in drafting, ask the user to
 * rephrase — that path is an explicit, already-active choice to draft, not a guess the system
 * made on the user's behalf.
 */
export type PlanDraftOutcome = {
    fallThrough: true;
} | AssistantTurnResult;
/**
 * P3 of the internal plan — how `assistant.ts`'s auto-trigger tells
 * `draftTurn` what to seed a *fresh* draft with (ignored on every later revision of an
 * already-drafting plan). `templateName` set means a template matched — the draft starts from
 * that template's own skeleton (today's personalization behavior, reused, not discarded — see
 * `buildPlanFromTemplate`'s doc comment — except the drafting call itself, not a separate
 * personalization call, does the adapting, so it's free to add/remove/split/reorder relative to
 * the skeleton rather than preserving it 1:1). `grounded: true` (only meaningful when
 * `templateName` is null) means ground the from-scratch draft in real repo state via a bounded
 * read_file/list_directory walk before drafting.
 */
export interface PlanDraftSeed {
    templateName: string | null;
    grounded: boolean;
}
/**
 * Owns plan mode's P1 exclusive drafting loop: while `AssistantSession.getPlanModeState(sessionId)`
 * is `active`, `assistant.ts`'s runTurn routes every message here instead of TurnInterpreter's
 * normal classify/tool-loop pipeline (INV-30 — no tool other than this call itself executes for
 * that session while drafting is active). Two designed exits: an explicit cancel/abort phrase
 * (handled entirely here), and P2's approval response once a draft is staged for
 * `awaiting_approval` (handed off to `PlanApprovalService.stageAndRespond` below the moment a
 * revision's `readyForApproval` is true — resolved via `turn(message, { planApprovalId,
 * planDecision })`, checked earlier in `assistant.ts`'s runTurn than this drafting path at all).
 *
 * The drafting call itself (plan-drafting.ts's draftPlanRevision) has no tool access of its own —
 * P3 grounds a from-scratch draft by running a separate, bounded read_file/list_directory
 * investigation walk first (see the `seed?.grounded` branch in `draftTurn` below) and feeding its
 * findings in as extra context, rather than giving the drafting call itself live tool-calling.
 * P3 also wired the automatic judgment-based trigger this class was previously waiting on:
 * `assistant.ts`'s runTurn now calls `session.enterPlanMode` and routes into `draftTurn` (with a
 * `PlanDraftSeed`) the moment `classifyTurnIntent` reports `matchedPlanTemplate !== null ||
 * needsMultiStepPlan` and no plan is already active — `PersonalAssistant.enterPlanMode` remains
 * available as a direct entry point too (tests, a future `/plan` command), unchanged.
 */
export declare class PlanDraftingService {
    private readonly planService;
    private readonly session;
    private readonly llmClient;
    private readonly model;
    private readonly planApproval;
    private readonly onTrace;
    private readonly agentLoop?;
    private readonly memory?;
    constructor(planService: PlanService, session: AssistantSession, llmClient: ILLMClient, model: () => string | undefined, planApproval: PlanApprovalService, onTrace: ((event: TraceEvent) => void) | undefined, agentLoop?: Pick<AgentLoop, "runSupervisorInvestigation"> | undefined, memory?: MemoryAdapter | undefined);
    private planAskPendingKey;
    /** Points at the one nested question a session's draft currently has staged, so cancelling the draft (or staging a newer question) can drop it. */
    private planAskSessionKey;
    private dropStagedAsk;
    /** Peeked by `assistant.ts`'s runTurn before it decides whether a `pendingClarificationId` belongs to this nested-ask side channel (P8) or AskClarificationService's harness-resume path (Q2) — the two staging stores are otherwise independent, so an opaque ID has no other way to say which one it came from. */
    isPendingAsk(id: string): Promise<boolean>;
    /**
     * Resolves a nested plan-drafting ask by ID (P8) — the drafting counterpart to
     * AskClarificationService.resolvePendingClarification, but folds the answer into the *next
     * drafting revision call* instead of resuming a paused harness run (there is none mid-draft).
     * Fail-closed (Protected Invariants) exactly like Q2: no answer, or one that doesn't validate
     * against exactly the staged questions (INV-28), leaves the turn in `needs_clarification`
     * rather than silently proceeding or discarding the batch.
     */
    resolvePendingAsk(sessionId: string, transcriptKey: string, pendingAskId: string, response: AskResponse | undefined, onUsage: (usage: TokenUsage) => void): Promise<AssistantTurnResult>;
    draftTurn(sessionId: string, transcriptKey: string, userMessage: string, onUsage: (usage: TokenUsage) => void, seed?: PlanDraftSeed, threadId?: string): Promise<PlanDraftOutcome>;
    private stillAwaitingApproval;
    /** Stages a single nested question (P8) and returns the `needs_clarification` result — mirrors AskClarificationService.stageAndRespond's "append the user's message, return no reply yet" shape, but into `plan-ask-pending:` instead of `ask-pending:`, and resolved by `resolvePendingAsk` above instead of a harness resume. */
    private stageNestedAsk;
    private cancelDrafting;
}
