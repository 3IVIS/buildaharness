import { WorldModel } from '../state/world-model.js';
import { OutputContract } from '../state/output-contract.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { EvidenceStore } from '../state/evidence-store.js';
import { Task } from '../state/task-graph.js';
import { AskQuestion, AskQuestionOption } from './escalate.js';
export type ReviewDimension = 'task_alignment' | 'world_model_consistency' | 'output_contract_precheck' | 'code_quality' | 'hypothesis_compatibility';
export interface DimensionResult {
    dimension: ReviewDimension;
    passed: boolean;
    reason: string;
}
export interface ReviewResult {
    passed: boolean;
    failed_dimensions: DimensionResult[];
    consecutive_failures: number;
    escalation_triggered: boolean;
}
export interface ProposedChange {
    description?: string;
    change_type?: string;
    required_resources?: string[];
    required_state_structures?: string[];
}
/**
 * Records a single review dimension's outcome into the per-task consecutive-failure counter
 * and derives escalation_triggered from it — the same bookkeeping reviewProposedChange itself
 * uses for its 5 lexical dimensions, exposed so an *additional* check (e.g. a semantic
 * consistency check layered on top — see harness-runtime.ts) gets identical
 * consecutive-failure/escalation treatment instead of a second, divergent mechanism.
 */
export declare function applyReviewOutcome(taskId: string, passed: boolean, consecutiveFailuresMap: Map<string, number>, failedDimension?: DimensionResult | DimensionResult[]): ReviewResult;
export declare function reviewProposedChange(proposedChange: ProposedChange, currentTask: Task | null, worldModel: WorldModel | null, outputContract: OutputContract | null, hypothesisSet: HypothesisSet | null, toolManifest: EvidenceStore | null, consecutiveFailuresMap: Map<string, number>): ReviewResult;
/**
 * Deterministically categorize failed review dimensions into candidate fixes — one static,
 * templated option per distinct failed dimension, no LLM call, nothing drafted from the
 * dimension's own `reason` text. Returns undefined (not an empty array) when fewer than two
 * distinct dimensions failed, or when more failed than Q0's MAX_OPTIONS_PER_QUESTION can
 * hold (silently dropping one would be worse than falling back) — both cases leave the call
 * site to fall back to today's plain missing_info halt, unchanged.
 */
export declare function diagnoseReviewFailureOptions(failedDimensions: DimensionResult[]): AskQuestionOption[] | undefined;
/** Wrap diagnoseReviewFailureOptions()'s output into an AskQuestion. Pure. */
export declare function buildReviewFailureQuestion(options: AskQuestionOption[]): AskQuestion;
