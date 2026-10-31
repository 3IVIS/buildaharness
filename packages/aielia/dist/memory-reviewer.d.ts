import { ChatMessage, ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { MemoryService, StageReviewerResult } from './memory-service.js';
import { UserFact, CandidateJudgement } from './fact-extraction.js';
import { FactCategory } from './turn-intent-classifier.js';
/**
 * M4 of the agent memory framework plan: a post-turn, cross-turn memory reviewer. The in-turn writer already catches a
 * fact stated in one message; the only thing this adds is aggregation across turns (a preference enforced by repetition,
 * a decision that held). It reads the session's USER messages only (the injected memory block stripped), proposes typed
 * operations, has each judged by a bounded semantic verifier, and hands the survivors to `MemoryService.stageReviewerOps`,
 * which stages them in the pending queue with their evidence (decision D1). No keyword, regex or substring judgement of
 * natural language anywhere here: language is judged by the two model calls, structure by plain code.
 *
 * Integration point for M3 (episodic digests): `ReviewerInput.digests` is accepted and passed to the reviewer as
 * additional context but nothing populates it yet; M3's session-edge digest can feed it without changing this module.
 */
/** `AUDIT_MEMORY_REVIEWER`: default **OFF** (opt-in layer; M4 always ships off). `1`/`true`/`on`/`yes`/`enabled` enables. */
export declare function memoryReviewerEnabled(env?: Record<string, string | undefined>): boolean;
/** `AUDIT_MEMORY_REVIEWER_VERIFY`: the bounded verifier call. Default ON when the reviewer runs; a falsy value skips it (the negative control: ops are then staged unverified). */
export declare function memoryReviewerVerifyEnabled(env?: Record<string, string | undefined>): boolean;
/** `AUDIT_MEMORY_REVIEWER_EVERY`: review every N user turns. Default 5 (to be calibrated in the pilot). */
export declare const DEFAULT_REVIEW_EVERY = 5;
export declare function memoryReviewerEvery(env?: Record<string, string | undefined>): number;
/** Most operations one review may stage; a bound on the output, not a language judgement. */
export declare const MAX_REVIEW_OPS = 5;
export type ReviewScope = 'general' | 'this_context';
export type ReviewVerification = 'supported' | 'unsupported' | 'not_checked';
/** One typed operation the reviewer proposes. `evidence` is the user's own words; it is stored and shown, never string-matched. */
export interface ReviewOp {
    kind: 'upsert' | 'retire' | 'noop';
    /** upsert: stable model-chosen key for a single-valued attribute (M1 supersession). */
    key?: string;
    /** upsert: the claim, phrased to preserve what the user said ("asked for X in this context" unless they stated a general preference). */
    text?: string;
    /** retire: the `id` of the existing fact (from the list the reviewer was shown) to propose retiring. */
    targetId?: number;
    evidence?: string;
    scope?: ReviewScope;
    category?: FactCategory;
    judgement?: CandidateJudgement;
}
export interface VerifiedReviewOp extends ReviewOp {
    verification: ReviewVerification;
    /** Verifier's one-line reason when it said unsupported. */
    reason?: string;
}
export interface ReviewerInput {
    /** The session transcript; only `user` messages are read as claims. */
    transcript: readonly ChatMessage[];
    /** Block last injected into the prompt; removed verbatim from every user message (feedback-loop prevention). */
    injectedBlock: string;
    /** Current durable facts, shown to the reviewer so a retire can name its target. `id` is the index the reviewer uses. */
    existingFacts: readonly {
        id: number;
        text: string;
        source: string;
    }[];
    /** M3 integration point: episodic digests of earlier sessions, context only. Unused until M3 lands. */
    digests?: readonly string[];
}
/** The user-only digest the reviewer sees: recent turns verbatim, older turns clipped, memory block stripped, total bounded. Pure formatting, no language judgement. */
export declare function buildUserDigest(transcript: readonly ChatMessage[], injectedBlock: string): string[];
/** One bounded reviewer call. Returns no ops (never throws) on any error or unparseable output: a failed review writes nothing. */
export declare function proposeMemoryOps(input: ReviewerInput, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<ReviewOp[]>;
/**
 * One bounded verifier call (same shape as grounding-check.ts, fail-open): is each op supported by the user's messages, at
 * the stated scope, and not a generalisation of a one-off request. Fail-open: an error, an unparseable answer or a missing
 * verdict leaves the op `not_checked` (it still only reaches the pending queue, never durable memory).
 */
export declare function verifyMemoryOps(ops: readonly ReviewOp[], input: ReviewerInput, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<VerifiedReviewOp[]>;
/** The facts the reviewer must read through `UserFact` shape — re-exported so the staging method has one type to take. */
export type ReviewerFact = UserFact;
/**
 * Trigger bookkeeping: a per-session counter of user turns since the last memory write (or review). Fires on the Nth
 * turn; a turn in which any memory write occurred resets it (the in-turn writer is already doing the job). Pure state,
 * no timers: it can only fire when `noteTurn` is called after a turn finished, so it never fires during a turn.
 */
export declare class ReviewTrigger {
    private readonly every;
    private counts;
    constructor(every?: () => number);
    noteTurn(sessionId: string, wroteMemoryThisTurn: boolean): boolean;
    reset(sessionId: string): void;
    count(sessionId: string): number;
}
export interface ReviewRunResult {
    proposed: number;
    stage: StageReviewerResult | undefined;
    /** The run was aborted (a new turn began) before it wrote anything. */
    aborted: boolean;
}
/**
 * Orchestrates one review: reviewer call, verifier call, staging. Owns the trigger counter and the single in-flight run,
 * which `abort()` cancels (checked between every await and again immediately before the writes, so an abort leaves no
 * partial write). Never throws. LLM usage is reported through `onUsage`, which the host folds into the session's spend.
 */
export declare class MemoryReviewer {
    private readonly memoryService;
    private readonly llmClient;
    private readonly model;
    private readonly getTranscript;
    readonly trigger: ReviewTrigger;
    private controller;
    private inFlight;
    constructor(memoryService: MemoryService, llmClient: ILLMClient, model: () => string | undefined, getTranscript: (sessionId: string) => Promise<ChatMessage[]>);
    /** Cancels the run in progress, if any (a new user turn began). */
    abort(): void;
    /** Resolves when the run in progress (if any) has finished; for hosts that must not exit mid-review and for tests. */
    settled(): Promise<void>;
    /** Starts a review off the caller's critical path and returns immediately. */
    start(sessionId: string, onUsage?: (u: TokenUsage) => void): void;
    /** Runs a review to completion (session edge). */
    runNow(sessionId: string, onUsage?: (u: TokenUsage) => void): Promise<ReviewRunResult>;
    private run;
}
