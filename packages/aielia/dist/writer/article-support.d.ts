import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta, Claim, Source, SourceStatus } from './article-model.js';
/**
 * Per-statement support check (T7), built on the pattern of grounding-check.ts: one bounded call that compares a claim
 * with the stored passages attached to it. The model judges; this module stores the verdict together with what it ran
 * on (the claim text and the source fingerprints), so effectiveSourceStatus can later refuse to show a verdict that no
 * longer applies. A check that could not run is never a pass: the claim keeps its status and the result says not_checked.
 */
export type SupportVerdict = Extract<SourceStatus, 'supported' | 'partly_supported' | 'not_supported' | 'contradicted'>;
export type SupportCheck = {
    status: 'checked';
    meta: ArticleMeta;
    verdict: SupportVerdict;
    reason: string;
} | {
    status: 'no_sources';
    meta: ArticleMeta;
} | {
    status: 'not_checked';
    meta: ArticleMeta;
    reason: string;
};
/** The sources linked to a claim by a supported_by link, in link order. */
export declare function sourcesForClaim(meta: ArticleMeta, claimId: string): Source[];
/** Text the model wrote or co-wrote is checked automatically (T7); a claim the writer alone wrote is checked on request. */
export declare function needsAutoCheck(claim: Claim): boolean;
export declare function checkClaimSupport(input: {
    meta: ArticleMeta;
    markdown: string;
    claimId: string;
    modelName: string;
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<SupportCheck>;
