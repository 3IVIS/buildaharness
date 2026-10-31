import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta, Link } from './article-model.js';
/**
 * The resolver (T4, T5, T6): after something changes, a model judges what else is affected. Stored links only choose
 * where to look first; the model reads every section's heading and opening and may find effects, and propose links,
 * beyond them. Every judgement of meaning is the model's; this module validates the ids it returns, applies the rules
 * (the resolver can mark a section needs-review but never clear it, and never touches a confirmed or hand-drawn link)
 * and reports what it did. A failure leaves the article as it was and says so.
 */
export type Change = {
    kind: 'text_edited';
    sectionIds: string[];
    summary: string;
} | {
    kind: 'correction';
    note: string;
    supersedes?: string;
};
export interface ResolveResult {
    status: 'resolved' | 'not_resolved';
    meta: ArticleMeta;
    flagged: {
        sectionId: string;
        reason: string;
    }[];
    proposedLinks: Link[];
    /** Model suggestions that named an id that does not exist, or a rule refused. Reported, not applied. */
    skipped: string[];
}
/** Section ids connected to the changed ones by a rests_on or repeats link, in either direction. */
export declare function linkedSectionIds(meta: ArticleMeta, changed: readonly string[]): Set<string>;
export declare function resolveChange(input: {
    meta: ArticleMeta;
    markdown: string;
    change: Change;
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<ResolveResult>;
export interface SourceImpact {
    claimId: string;
    impact: 'none' | 'recheck' | 'likely_wrong';
    reason: string;
}
export interface SourceChangeResult {
    status: 'assessed' | 'not_assessed';
    meta: ArticleMeta;
    impacts: SourceImpact[];
}
/** Whether a changed source matters to the claims that cite it. A claim that matters gets needsRecheck; a likely wrong one also flags its section. */
export declare function assessSourceChange(input: {
    meta: ArticleMeta;
    sourceId: string;
    before: string;
    after: string;
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<SourceChangeResult>;
