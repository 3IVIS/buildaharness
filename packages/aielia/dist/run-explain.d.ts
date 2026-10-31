import { AssistantTrace, AssistantSource, AssistantTurnResult } from './assistant.js';
import { AnswerClaim } from './answer-claim.js';
import { MemoryInjection } from './memory-service.js';
import { AssistantToolStep } from './tool-step.js';
import { GoalGraphState } from './goal-graph-service.js';
/**
 * The one place that explains a finished turn ("why", "layers", "sources", "steps", "plan").
 * The CLI prints these lines and chat-ui shows the same lines in a panel, so what the user is told
 * about a turn cannot drift between surfaces. Everything here is a pure function of data the turn
 * already produced — no I/O, no UI.
 */
/** What a surface remembers about the last turn. All fields are optional: a staged, declined or fast-path turn has no trace. */
export interface TurnExplainInput {
    trace?: AssistantTrace;
    /** True when the turn skipped the harness entirely (a self-contained trivial question). */
    harnessSkipped?: boolean;
    /** Why there is no trace, when the surface knows a more specific reason than the generic one. */
    noTraceReason?: string;
    answerClaim?: AnswerClaim;
    memoryInjection?: MemoryInjection;
    sources?: AssistantSource[];
    toolSteps?: AssistantToolStep[];
    planStatus?: AssistantTurnResult['planStatus'];
    /** The session's goal threads. When there is no drafted plan but threads have tasks, /plan says the request was worked as tracked goal tasks instead of "No active plan". */
    goalGraph?: GoalGraphState;
}
export declare const FAST_PATH_REASON = "No harness trace \u2014 the last turn was a simple, self-contained question answered directly without activating the harness (fast path).";
export declare const GENERIC_NO_TRACE_REASON = "No harness trace for the last turn (nothing to explain yet, or it took the fast path).";
export declare const NO_SOURCES_TEXT = "No sources for the last turn (it used no file/web tool calls).";
export declare const NO_STEPS_TEXT = "No tool steps for the last turn.";
export declare const NO_PLAN_TEXT = "No active plan for this session.";
export declare const NO_DRAFTED_PLAN_BUT_GOAL_TASKS_TEXT = "No drafted plan for this session. The request was worked as tracked goal tasks (/goals):";
/** Slash commands that open the explanations. Shared so the CLI's dispatch table and chat-ui's composer recognise the same words. */
export declare const EXPLAIN_COMMANDS: readonly ["/why", "/layers", "/sources", "/steps", "/plan"];
export type ExplainCommand = (typeof EXPLAIN_COMMANDS)[number];
export declare function verificationHealthLabel({ strength, feasibility }: AssistantTrace['verificationHealth']): string;
/**
 * Turns AnswerClaim's mechanically-derived verification_status into the "this is true" vs "I found X
 * but couldn't independently verify it" text. One pure function so a future change can't silently
 * collapse the four branches back into one generic phrasing.
 */
export declare function answerClaimLabel(claim: AnswerClaim): string;
type BatchBudget = NonNullable<AssistantTrace['batchBudget']>;
/** One-line found / not found / truncated tally for a batch-research turn (absent on every other turn). */
export declare function batchBudgetSummaryLine(batchBudget: BatchBudget): string;
/** `/why` — confidence, whether the reply was checked against what was read, the layers that fired (in order), and what memory the prompt held. */
export declare function explainWhy(input: TurnExplainInput): string[];
/** `/layers` — every one of the 11 layers: fired or not, and why; plus the per-item batch breakdown on a batch turn. */
export declare function explainLayers(input: TurnExplainInput): string[];
/** `/sources` — the files and URLs the turn consulted, each once. */
export declare function explainSources(input: TurnExplainInput): string[];
/** `/steps` — the tool calls the turn made, in order. */
export declare function explainSteps(input: TurnExplainInput): string[];
/** `/plan` — the active plan's task checklist. */
export declare function explainPlan(input: TurnExplainInput): string[];
/** Dispatches a bare slash command to its explainer; undefined for anything else (including `/plan graph` and other arguments, which are not explanations). */
export declare function explainCommand(message: string, input: TurnExplainInput): string[] | undefined;
export {};
