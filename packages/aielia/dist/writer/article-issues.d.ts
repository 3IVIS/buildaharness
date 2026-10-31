import { ArticleMeta, Claim } from './article-model.js';
/**
 * Issues in batches. Everything that needs the writer's attention is grouped by what it is, so it can be dealt with one category at a time
 * or all together. This module only decides which items belong to which category (from the article's own records, no language judgement);
 * the service runs the batch actions.
 *
 *  suggestions   suggested changes waiting for Accept or Reject
 *  comments      open reviewer comments the writer can act on (comments in conflict are listed apart: they need the writer's choice)
 *  checkable     factual claims with a stored source passage that have not been checked, or whose check no longer applies
 *  unsupported   factual claims with no source, or that their source does not support
 *  sections      sections marked as needing review
 *  links         links Aielia proposed (between sections, and between claims and sources) that wait for the writer
 *  stale         suggestions that can no longer be applied because the text under them changed
 */
export type IssueCategory = 'suggestions' | 'comments' | 'checkable' | 'unsupported' | 'sections' | 'links' | 'stale';
export interface IssueItem {
    id: string;
    label: string;
    detail?: string;
}
export interface IssueBatch {
    category: IssueCategory;
    title: string;
    items: IssueItem[];
    /** Open comments that conflict with each other. Not part of any batch action. */
    needsYourChoice?: IssueItem[];
}
export declare const ISSUE_CATEGORIES: IssueCategory[];
/** The factual claims that can be checked right now: a stored passage is attached and nothing valid has been said about the claim yet. */
export declare function checkableClaims(meta: ArticleMeta): Claim[];
/** The factual claims that are not backed and cannot be checked now: no source, a source with no passage to read, or a source that does not support them. */
export declare function unsupportedClaims(meta: ArticleMeta): Claim[];
export declare function collectIssues(meta: ArticleMeta): IssueBatch[];
export declare function issueCount(batches: readonly IssueBatch[]): number;
/**
 * What is left before the article is ready, as plain lines for the answering model, so "what is left?" is answered from the article's own
 * records and not from a guess. At most a few items per group; empty when nothing is open.
 */
export declare function renderIssuesForChat(meta: ArticleMeta, perGroup?: number): string;
/**
 * The article's records cut down to what bears on one piece of text, so `collectIssues` on the result lists only the issues there: suggestions and
 * comments on that text, claims in it, and the section it is in (with the links that start from that section or from a claim in the text).
 */
export declare function issuesInRange(meta: ArticleMeta, range: {
    start: number;
    end: number;
}): ArticleMeta;
