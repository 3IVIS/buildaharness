import { ILLMClient, TokenUsage, ToolDefinition } from '@buildaharness/runtime';
import { RepoIndex } from './repo-search.js';
/**
 * Checking a batch of claims against a repository with a model that can look things up: it searches, reads some lines, and answers each claim with
 * a verdict and the file lines and exact words that decide it. The loop owns everything mechanical: it runs the lookups, refuses answers whose quoted
 * words are not in the named file, and sends the claims that came back unsettled or unsourced to the model once more in the same conversation
 * (the earlier turns are the shared start of that call, so a provider's prompt cache serves them). The model judges; it is never trusted on a quote.
 */
export type LoopVerdict = 'supported' | 'partly_supported' | 'contradicted' | 'not_supported' | 'not_about_code';
export interface LoopEvidence {
    /** Repository path. */
    file: string;
    /** Line range of the excerpt in the file as found (1-based), recomputed from the file, not taken from the model. */
    from: number;
    to: number;
    excerpt: string;
}
export interface LoopResult {
    id: string;
    verdict: LoopVerdict;
    reason: string;
    /** Only excerpts that were found word for word in their file. */
    evidence: LoopEvidence[];
    /** What was searched, when the claim stayed unsettled. */
    searched: string[];
    /** Why this result is not trustworthy, when it is not (no answer, no usable quote); absent for a settled claim. */
    problem?: string;
}
export interface LoopStep {
    tool: string;
    input: Record<string, unknown>;
    chars: number;
}
export interface LoopOptions {
    model?: string;
    onUsage?: (usage: TokenUsage) => void;
    onStep?: (step: LoopStep) => void;
    /** The most lookups for the first pass and again for the follow-up pass. Past it the model is told to answer. */
    maxToolCalls?: number;
    /** The most model turns for one pass (a safety net against a model that never answers). */
    maxTurns?: number;
    /** The most tokens one model turn may produce (default 12000: a 25-claim answer is about 6000). A turn that runs away costs a whole run otherwise. */
    maxTokens?: number;
    /** Send unsettled claims back once (default true). */
    gapPass?: boolean;
}
export declare const REPO_TOOLS: ToolDefinition[];
/** Where the excerpt sits in the file: its first and last line, or undefined when its words are not there. `...` inside an excerpt joins separate pieces. */
export declare function locateExcerpt(text: string, excerpt: string): {
    from: number;
    to: number;
} | undefined;
/** Turns the model's answer into one result per claim; anything missing or unquotable is marked with its problem. */
export declare function checkAnswers(claimIds: readonly string[], rows: unknown, index: RepoIndex): LoopResult[];
export declare function verifyBatchWithTools(input: {
    claims: readonly {
        id: string;
        quote: string;
    }[];
    articleText: string;
}, index: RepoIndex, llm: ILLMClient, opts?: LoopOptions): Promise<LoopResult[]>;
