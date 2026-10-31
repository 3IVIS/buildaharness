import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { Claim, Section } from './article-model.js';
/**
 * Claim extraction and reconciliation (T2). A model reads the sections and says which statements are claims and which
 * stored claim each one is (by meaning); this module checks that every quote really occurs in the text, gives the claim
 * its section from the text's own structure, and applies the match rules from the article-model plan, section 6:
 *  - a sure match keeps the id; changed wording resets the check (editClaimText);
 *  - an unsure match keeps the claim and marks it "moved or changed, check": not dropped, not silently re-created;
 *  - a confirmed claim the model no longer finds is kept and marked for a check, never dropped silently;
 *  - an unconfirmed claim that is gone is dropped but reported;
 *  - what the model says about a claim the writer confirmed never changes its kind.
 * Any failure leaves the claims as they were and says so.
 */
export interface ExtractionResult {
    status: 'extracted' | 'not_extracted';
    claims: Claim[];
    added: string[];
    matched: string[];
    /** Kept but marked needsRecheck because the match was unsure or a confirmed claim could not be found. */
    flagged: string[];
    /** Unconfirmed claims that no longer exist in the text. */
    removed: Claim[];
    /** Model claims whose quote does not occur in the text, so they cannot be anchored. Reported, not stored. */
    unanchored: string[];
}
/** Sections grouped so one call stays within a size bound. A section larger than the bound goes alone. */
export declare function batchSections(sections: readonly Section[], markdown: string, maxChars?: number): Section[][];
export declare function extractClaims(input: {
    markdown: string;
    sections: readonly Section[];
    claims: readonly Claim[];
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<ExtractionResult>;
/** Links that start or end at a claim the article no longer has (an unconfirmed claim whose sentence was reworded is dropped by extraction): left in place they fail the integrity check. */
export declare function dropLinksToMissingClaims<M extends {
    claims: readonly {
        id: string;
    }[];
    links: readonly {
        from: {
            type: string;
            id: string;
        };
        to: {
            type: string;
            id: string;
        };
    }[];
}>(meta: M): M;
