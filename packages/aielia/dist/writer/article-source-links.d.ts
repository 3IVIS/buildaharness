import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta, Claim, Link } from './article-model.js';
/**
 * Sources for the text under the cursor. The writer clicks in the text or selects a phrase; the unit is the selection, or else the
 * sentence around the cursor. Claims whose text overlaps the unit are the ones whose sources are shown, and a source dropped there is
 * attached to them (a claim is created for the sentence when there is none). A source dropped elsewhere (the chat, or with no
 * cursor) is only stored; a model then proposes which claims it bears on, and the writer confirms.
 */
export interface TextRange {
    start: number;
    end: number;
}
export interface TextUnit extends TextRange {
    quote: string;
}
/** The selection (trimmed) if there is one, else the sentence around the cursor, never crossing a blank line. A heading line is its own unit. */
export declare function textUnitAt(markdown: string, start: number, end?: number): TextUnit | undefined;
/** Factual claims whose text overlaps the range. */
export declare function claimsInRange(meta: ArticleMeta, range: TextRange): Claim[];
export type AttachResult = {
    ok: true;
    meta: ArticleMeta;
    claimIds: string[];
    createdClaim: boolean;
} | {
    ok: false;
    reason: string;
};
/** Attaches a source to the text in the range: to the claims there, or to a new claim for that text. The links are hand-drawn, so the assistant cannot remove them. */
export declare function attachSourceToText(meta: ArticleMeta, markdown: string, range: TextRange, sourceId: string, now: string): AttachResult;
export interface SourceLinkProposal {
    status: 'proposed' | 'failed';
    meta: ArticleMeta;
    added: Link[];
    skipped: string[];
}
/** A source that was stored without saying what it is for: a model proposes which claims it bears on. Proposals wait for the writer. */
export declare function proposeSourceLinks(input: {
    meta: ArticleMeta;
    sourceId: string;
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<SourceLinkProposal>;
