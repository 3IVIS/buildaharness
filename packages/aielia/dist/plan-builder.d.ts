import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { DecomposedTaskSpec } from './decomposition-classifier.js';
import { PlanTemplate } from './plan-templates/index.js';
export interface Plan {
    templateName: string;
    successCriteria: string;
    tasks: DecomposedTaskSpec[];
    /**
     * Why this approach, not just what the success criteria are — optional for now since neither
     * buildPlanFromTemplate's template-personalization call nor any other current producer of a
     * Plan asks the LLM for one; plan-store.ts's createPlanRecord defaults it to '' when absent.
     * A future from-scratch drafting path (plan mode's P3) is expected to populate it.
     */
    rationale?: string;
}
/**
 * Spends one real LLM call personalizing `template`'s task skeleton to `message` —
 * only called once classifyTurnIntent has already named a matchedPlanTemplate, so an
 * ordinary turn never pays for this. Same "malformed/incomplete JSON is the expected
 * failure mode, not the edge case" fallback classifyTurnIntent itself uses: any parse
 * failure or a response with fewer than 2 usable tasks returns null, meaning "fall back to
 * the caller's own ad hoc decomposition for this turn" rather than throwing.
 *
 * Each output task's `riskLevel` is attached from the matching skeleton task's own
 * `risk_level` (curated by whoever wrote the template's JSON) by id, not asked of the LLM —
 * the template already has this, more accurately than an LLM re-deriving it from a
 * personalized one-line description would, and it costs zero extra output tokens. Falls back
 * to 'LOW' only for the pathological case of a task id the LLM invented that doesn't match any
 * skeleton task (the id/depends_on-must-match-skeleton instruction above means this should not
 * happen in practice).
 */
export declare function buildPlanFromTemplate(llmClient: ILLMClient, message: string, template: PlanTemplate, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<Plan | null>;
