import { Task, LayerPolicyMode } from '@buildaharness/harness';
import { ILLMClient, TokenUsage, ReminderStore, ChatMessage } from '@buildaharness/runtime';
import { AmbiguityGuardMode } from './ambiguity-guard-flag.js';
import { TurnIntentClassification } from './turn-intent-classifier.js';
import { PlanRecord } from './plan-store.js';
import { PlanService } from './plan-service.js';
import { AssistantTurnResult } from './assistant-types.js';
/**
 * `AUDIT_DECOMPOSITION` gate — feature-value audit (Phase C4 of the internal plan). Default
 * **ON**: the classifier's `decomposedTasks` graph and the single-task
 * `reframeTaskDescriptionWithLLM` call both shape the turn today, so an unset / empty / truthy
 * value keeps that behaviour. Set to a falsy value (`0` / `false` / `off` / `no` / `disabled`) to
 * take the single-task path: the raw user message as one `respond` task, no decomposition, no
 * reframe call. The classifier call itself is untouched (it also produces the intent/risk fields
 * every arm needs). Read at exactly one call site — the top of `resolveTasks()` below. An active
 * plan's own tasks are not decomposition and are unaffected. Same shape as
 * `semanticContradictionEnabled()` (contradiction-checker.ts).
 */
export declare function decompositionEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * The front portion of runTurn — plan-cancel-bypass detection, the classifyTurnIntent call, the
 * message-level risk-gate decision, and (via `resolveTasks`) decomposition/plan-template
 * resolution — as a pure decision-maker. Deliberately no MemoryAdapter/onTrace dependency beyond
 * what's passed as plain arguments/collaborators (PlanService, ReminderStore), so this stays
 * unit-testable without heavy mocks. Does NOT append to the transcript or call onTrace itself —
 * every variant below carries enough data for the sequencer (assistant.ts) to do both, in the
 * exact order the pre-split code did.
 */
export type TurnInterpretation = {
    kind: 'bypass';
    result: AssistantTurnResult;
    transcriptAppend: {
        user: string;
        assistant: string;
    };
    planUpdatedTrace: {
        templateName: string | null;
        completionPct: number;
    };
} | {
    kind: 'needs_approval';
    classification: TurnIntentClassification;
    result: AssistantTurnResult;
}
/** AL3a — the request doesn't determine the action; `result` is the clarifying question, returned before anything is staged. */
 | {
    kind: 'needs_question';
    classification: TurnIntentClassification;
    result: AssistantTurnResult;
} | {
    kind: 'proceed';
    classification: TurnIntentClassification;
    planForCancelCheck: PlanRecord | null;
};
export interface ResolvedTasks {
    initialTasks: Task[];
    activePlan: PlanRecord | null;
    /** Only set when a NEW plan match was attempted this turn (i.e. no active plan was already being resumed) — mirrors the original code's `else` branch, which is the only place this trace fired. */
    planClassifiedTrace?: {
        isCandidate: boolean;
        matchedTemplate: string | null;
    };
}
export declare class TurnInterpreter {
    private readonly llmClient;
    private readonly model;
    private readonly planService;
    private readonly reminderStore;
    private readonly ambiguityGuardMode;
    private readonly layerPolicyMode;
    constructor(llmClient: ILLMClient, model: () => string | undefined, planService: PlanService, reminderStore: ReminderStore, ambiguityGuardMode?: AmbiguityGuardMode, layerPolicyMode?: LayerPolicyMode);
    /** AL8b: decomposition-reframe policy decision; any error ⇒ today's behaviour (allowed). */
    private reframePolicyAllows;
    interpretIntent(params: {
        userMessage: string;
        sessionId: string;
        toolLoopWillRun: boolean;
        approved: boolean;
        dangerouslySkipPermissions: boolean;
        onUsage: (usage: TokenUsage) => void;
        /** Recent transcript, used only by the AL3a ambiguity guard so an answer to an earlier question isn't re-asked. */
        recentTranscript?: ChatMessage[];
        /** Constraints stated earlier this session; shown to the classifier so the message can lift one. */
        standingConstraints?: string[];
        /** Keyed facts already stored; shown to the classifier so it reuses their keys. */
        knownFactKeys?: {
            key: string;
            text: string;
        }[];
        /** An automatic audit retry passes the classification of the turn it corrects, so its own nudge is not classified (see classificationForAuditRetry). */
        inheritedClassification?: TurnIntentClassification;
    }): Promise<TurnInterpretation>;
    /**
     * Decomposition/plan-template resolution — only meaningful (and only ever called by the
     * sequencer) once a turn is known NOT to be trivial, since a trivial turn returns before any
     * of this would matter and must not spend buildPlanFromTemplate's LLM call for nothing.
     */
    resolveTasks(params: {
        userMessage: string;
        sessionId: string;
        classification: TurnIntentClassification;
        planForCancelCheck: PlanRecord | null;
        onUsage: (usage: TokenUsage) => void;
        /** The turn only asks about the active plan (turn-intent-classifier.ts's isPlanQuestion, routing enabled): keep the plan for display but don't let it drive the turn's tasks. */
        planQuestion?: boolean;
    }): Promise<ResolvedTasks>;
}
