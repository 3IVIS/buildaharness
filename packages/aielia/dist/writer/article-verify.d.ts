import { ArticleMeta, Claim } from './article-model.js';
/**
 * Verifying claims (pure parts): which claims to take, and how a search that found nothing is said. The search, the reading and the model
 * check themselves are run by ArticleService.verifyClaims; whether a page backs a claim is the support check's judgement, never decided here.
 */
export type VerifyOutcome = 'supported' | 'partly_supported' | 'contradicted' | 'not_supported' | 'no_source_found' | 'cannot_search' | 'search_failed' | 'could_not_check';
export interface VerifyEntry {
    claimId: string;
    quote: string;
    outcome: VerifyOutcome;
    /** Addresses of pages found and kept as sources for the claim. */
    found: string[];
    reason?: string;
}
export interface VerifyReport {
    entries: VerifyEntry[];
    /** Factual claims left for another run because of the limit. */
    leftOver: number;
    /** The writer stopped the run: the entries are the claims checked before that. */
    stopped?: boolean;
}
export declare const DEFAULT_VERIFY_LIMIT = 10;
export declare const DEFAULT_VERIFY_PAGES = 3;
/**
 * The claims to verify, in text order: the factual ones that are not already supported by a check that still counts. Named claims are taken
 * even when supported (the writer asked for them). At most `limit` are taken; the count of the rest is returned.
 */
export declare function verifyTargets(meta: ArticleMeta, claimIds: readonly string[] | undefined, limit: number): {
    ids: string[];
    leftOver: number;
};
/** The lookup that still applies to the claim (its text has not changed since), or undefined. */
export declare function currentLookup(claim: Claim): NonNullable<Claim['lookup']> | undefined;
/** What the page says about a claim that was looked for and not backed; undefined when there was no lookup or sources have since been attached. */
export declare function lookupNote(claim: Claim, hasSources: boolean): string | undefined;
/** One sentence for the chat or a notice about a finished run. */
export declare function summarizeVerify(report: VerifyReport): string;
/**
 * Where the whole article stands, from its records: a run only looks at some claims (a limit, or the ones already backed are skipped), so a later
 * run's summary alone would read as if it were the result for the whole article. Empty when the article has no factual claims.
 */
export declare function summarizeArticleSources(meta: ArticleMeta): string;
