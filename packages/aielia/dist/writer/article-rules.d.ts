import { ArticleMeta, Claim, Section, Source, SourceStatus } from './article-model.js';
/**
 * The rules the article model must always keep (plans/aielia_write_article_model_plan.html, section 9), as pure functions.
 * Each returns a new value or a refusal with a reason; none mutates its input, and none deletes silently.
 */
export type Actor = 'writer' | 'resolver' | 'assistant' | 'editor';
export type Refusal = {
    ok: false;
    reason: string;
};
/**
 * What a claim's source status may be shown as. A check only counts if it ran on the claim's current text against the
 * current stored passages; otherwise the verdict is not shown as supported (not_checked), or stale when a source changed.
 */
export declare function effectiveSourceStatus(claim: Claim, sources: readonly Source[]): SourceStatus;
/** Changing a claim's text resets its check result. */
export declare function editClaimText(claim: Claim, quote: string, by: 'model' | 'writer', now: string): Claim;
/** The resolver may mark a section needs review; it cannot mark it clean. Only the writer clears it. */
export declare function setSectionReview(meta: ArticleMeta, sectionId: string, state: Section['review']['state'], reason: string | undefined, by: Actor, now: string): {
    ok: true;
    meta: ArticleMeta;
} | Refusal;
/** Confirmed and hand-drawn links are never changed or removed by the assistant; it can only propose a change. */
export declare function removeLink(meta: ArticleMeta, linkId: string, by: Actor): {
    ok: true;
    meta: ArticleMeta;
} | Refusal;
export declare function confirmLink(meta: ArticleMeta, linkId: string, by: Actor): {
    ok: true;
    meta: ArticleMeta;
} | Refusal;
export interface Problem {
    where: string;
    message: string;
}
/** Every id referenced by a link, comment, claim or suggestion must exist. Broken records are reported and kept, never deleted. */
export declare function checkIntegrity(meta: ArticleMeta): Problem[];
export interface Readiness {
    unsourcedFactualClaims: number;
    staleOrUnsupportedClaims: number;
    openComments: number;
    sectionsNeedingReview: number;
}
/** Computed, never stored by hand (D3: warn only). Publishing is allowed regardless; a snapshot records these counts. */
export declare function computeReadiness(meta: ArticleMeta): Readiness;
export interface Snapshot {
    readonly kind: 'published' | 'checkpoint';
    readonly label?: string;
    readonly at: string;
    readonly markdown: string;
    readonly meta: ArticleMeta;
    readonly readiness: Readiness;
}
/** A snapshot is a frozen deep copy: later edits to the working article cannot change it. */
export declare function createSnapshot(kind: Snapshot['kind'], markdown: string, meta: ArticleMeta, now: string, label?: string): Snapshot;
/** Restoring creates a new working version from the snapshot; the snapshot itself and the history are untouched. */
export declare function restoreSnapshot(snapshot: Snapshot): {
    markdown: string;
    meta: ArticleMeta;
};
