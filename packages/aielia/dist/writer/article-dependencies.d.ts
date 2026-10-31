import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ArticleMeta, Link } from './article-model.js';
/**
 * Dependency mapping between sections (T4). A section "rests on" another when it builds on it (a thesis and its arguments), and
 * "repeats" another when it restates it (an opening or a conclusion repeating a figure). The assistant proposes links, the writer
 * confirms, removes or draws them by hand; a confirmed or drawn link is never changed by the assistant. When a section changes,
 * the resolver uses these links to say which other sections need a look.
 */
export declare const DEPENDENCY_KINDS: readonly ["rests_on", "repeats"];
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export declare const DEPENDENCY_LABEL: Record<DependencyKind, string>;
export interface SectionDependencies {
    /** Links where this section is the one that depends. */
    uses: Link[];
    /** Links where another section depends on this one. */
    usedBy: Link[];
}
export declare function dependenciesOf(meta: ArticleMeta, sectionId: string): SectionDependencies;
/** True when adding "from rests on to" would make a circle of "rests on" links (A rests on B rests on A). */
export declare function wouldCycle(meta: ArticleMeta, from: string, to: string): boolean;
export type AddLinkResult = {
    ok: true;
    meta: ArticleMeta;
    link: Link;
} | {
    ok: false;
    reason: string;
};
/** The writer draws a link by hand. It is origin "drawn", so the assistant can never remove or change it. */
export declare function addDrawnLink(meta: ArticleMeta, from: string, to: string, kind: DependencyKind, now: string): AddLinkResult;
export interface DependencyProposal {
    status: 'proposed' | 'failed';
    meta: ArticleMeta;
    added: Link[];
    /** Proposals dropped: unknown section, a duplicate, a section depending on itself, or a circle. */
    skipped: string[];
    /** Why the search failed, when it did: the error the model call raised, or that its answer could not be read. */
    reason?: string;
}
export declare function proposeDependencies(input: {
    meta: ArticleMeta;
    markdown: string;
    now: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<DependencyProposal>;
