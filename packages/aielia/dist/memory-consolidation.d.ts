import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { UserFact } from './fact-extraction.js';
/**
 * Memory consolidation and staged forgetting (M5 of the agent memory framework plan).
 *
 * Pure pieces only: the flag, the retention window, the bounded model pass that PROPOSES changes, and
 * the deterministic archive-candidate rule. Applying a proposal lives in MemoryService (the only
 * place allowed to write the durable store, through `commitDurable`). Nothing here writes anything.
 *
 * D2: no lexical similarity anywhere. Whether two facts overlap is the model's judgement; the only
 * deterministic rule is on the usage fields M1 added (timestamps and counters), never on text.
 */
/** `AUDIT_MEMORY_CONSOLIDATION`: default OFF; `1/true/on/yes/enabled` enables. Read fresh each call. */
export declare function memoryConsolidationEnabled(env?: Record<string, string | undefined>): boolean;
/** D4: retention window, start 90 days, to be calibrated. `AUDIT_MEMORY_RETENTION_DAYS` overrides (a positive number). */
export declare const DEFAULT_MEMORY_RETENTION_DAYS = 90;
export declare function memoryRetentionDays(env?: Record<string, string | undefined>): number;
export type ProposalKind = 'merge' | 'supersede' | 'tighten' | 'archive';
/** A staged change waiting for the user (`/memory consolidate accept|dismiss <n>`). Nothing here has been applied. */
export interface ConsolidationProposal {
    id: string;
    kind: ProposalKind;
    /** `text|extractedAt` ids of the durable facts the proposal touches. */
    factIds: string[];
    /** merge/tighten: the replacement wording. */
    text?: string;
    /** supersede: the id of the fact that replaces the retired ones in meaning (informational). */
    by?: string;
    reason: string;
    createdAt: string;
    /** True when any touched fact is `user_asserted`: the user said it themselves, so the UI must say so. */
    touchesUserAsserted: boolean;
}
export interface ConsolidationState {
    /** Highest audit seq already considered. The audit log's rotation keeps everything newer than this. */
    lastSeq: number;
    at?: string;
    nextProposalNo?: number;
    /** Signatures of proposals the user dismissed, so the same proposal is not raised again. */
    dismissed?: string[];
}
export interface RawProposal {
    kind: 'merge' | 'supersede' | 'tighten';
    refs: string[];
    text?: string;
    by?: string;
    reason: string;
}
export interface ConsolidationInput {
    facts: Array<{
        ref: string;
        text: string;
        source: string;
        key?: string;
        injectedCount?: number;
        lastInjectedAt?: string;
    }>;
    recentChanges: Array<{
        op: string;
        text: string;
    }>;
    budget: {
        usedChars: number;
        budgetChars: number;
    };
}
export declare const CONSOLIDATION_SYSTEM_PROMPT: string;
/**
 * One bounded call proposing merges, supersessions and tightenings. Returns the validated proposals,
 * or `undefined` when the call failed or its answer was unusable (the caller then changes nothing,
 * not even the watermark, so the next run retries). Anything the model returns that does not name
 * real refs, repeats a ref, or has the wrong shape for its kind is dropped individually.
 */
export declare function proposeConsolidationOps(input: ConsolidationInput, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<RawProposal[] | undefined>;
/**
 * Deterministic archive rule over M1's usage fields, never over text: a live fact whose last sign of
 * use (`lastInjectedAt`, else when it was stated) is older than the retention window. "Injected" means
 * "was in the prompt", which is weaker than "was used"; the proposal says so rather than claiming usage.
 */
export declare function findArchiveCandidates(facts: UserFact[], nowMs: number, windowDays: number): UserFact[];
