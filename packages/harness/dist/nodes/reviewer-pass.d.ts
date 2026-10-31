import { WorldModel, Belief, BeliefDepGraph, DepGraphBudget } from '../state/world-model.js';
import { HypothesisSet } from '../state/hypothesis-set.js';
import { TaskGraph } from '../state/task-graph.js';
import { Diagnostics } from '../state/diagnostics.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { EvidenceStore } from '../state/evidence-store.js';
export interface ReviewLensResult {
    findings: string[];
    reopened_task_ids: string[];
}
export type ReviewerVerdictSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type ReviewerVerdictLens = 'implementer' | 'reviewer' | 'adversarial';
/**
 * Bounded, single-slot verdict that survives into the next iteration's ControlState
 * resolve (Phase I / ADR-003 finding F-3, authority-map ruling A-4). Mirrors
 * reviewer.py's ReviewerVerdict exactly — see resolve-control-state.ts's
 * applyPendingReviewerVerdict() for the consuming side (INV-18).
 */
export interface ReviewerVerdict {
    severity: ReviewerVerdictSeverity;
    lens: ReviewerVerdictLens;
    summary: string;
}
export interface ReviewPassResult {
    implementer_findings: string[];
    reviewer_findings: string[];
    adversarial_findings: string[];
    reopened_task_ids: string[];
    pending_verdict: ReviewerVerdict | null;
}
/**
 * Optional semantic escalation layered on top of the plain `.includes()` substring check below —
 * called only for a criterion the substring check found no coverage for, so a belief that covers
 * a success criterion in different words (a paraphrase, or any non-English phrasing) isn't
 * wrongly reported as an uncovered gap. See Phase 2/Decision 3b of
 * the internal plan — mirrors the existing
 * contradictionChecker/semanticChangeReviewer/semanticFailureMatcher hooks on HarnessRuntime
 * (packages/harness/src/harness-runtime.ts). A caller can cheaply return `false` without an LLM
 * call for a criterion it judges the substring check already covers.
 */
export type SemanticCriterionCoverage = (criterion: string, beliefs: Belief[]) => Promise<boolean>;
/** A host's way to say a success criterion is a meta-instruction ("respond helpfully") that no belief could ever state — it is skipped, not reported as uncovered. Default: every criterion is checkable. */
export type CriterionCheckable = (criterion: string) => boolean;
export interface PropagationQueue {
    reopenedTaskIds: string[];
}
export declare function drainPropagationQueue(queue: PropagationQueue): string[];
export declare function reviewerPass(worldModel: WorldModel, successCriteria: string[], failureDiagnostics: FailureDiagnostics, beliefDepGraph: BeliefDepGraph, depGraphBudget: DepGraphBudget, hypothesisSet: HypothesisSet, taskGraph: TaskGraph, diagnostics: Diagnostics, evidenceStore: EvidenceStore, propagationQueue: PropagationQueue, runAdversarialLens?: boolean, semanticCriterionCoverage?: SemanticCriterionCoverage, isCheckableCriterion?: CriterionCheckable): Promise<ReviewPassResult>;
