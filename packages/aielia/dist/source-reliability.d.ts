import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { AssistantSource } from './assistant-source.js';
export type SourceReliability = 'HIGH' | 'MEDIUM' | 'LOW';
export interface SourceAssessment {
    path: string;
    reliability: SourceReliability;
    reason: string;
}
export interface SourceWeighing {
    assessments: SourceAssessment[];
    /**
     * `false` only when the sources materially disagree or differ in reliability AND the reply leans on a
     * lower-reliability one, or presents them as equal without saying so. Everything else is `true`.
     */
    weighed: boolean;
    /** One or two sentences telling the assistant how to weigh the sources — used only when `weighed` is false. */
    note?: string;
}
/** Prefix of the evidence ids this module writes, so a reader can tell an assessment from a tool observation. */
export declare const SOURCE_RELIABILITY_EVIDENCE_PREFIX = "source-reliability:";
/**
 * `AUDIT_SEMANTIC_SOURCE_RELIABILITY` gate. Default **OFF**: a turn's sources are never assessed and the
 * reply is never revised, exactly as before. A truthy value (`1` / `true` / `on` / `yes` / `enabled`)
 * turns on one bounded LLM call per multi-source turn, and one revision of an answer the call judged not to
 * have weighed its sources. It changes what the assistant says, so it ships off until a benchmark shows it
 * helps. Read at one site: `AgentLoop.createHarnessProposer`.
 */
export declare function sourceReliabilityEnabled(env?: Record<string, string | undefined>): boolean;
/** The distinct read sources a turn used (a directory listing is not a source of facts). Deduplicated by tool + path. */
export declare function distinctSources(sources: AssistantSource[]): AssistantSource[];
/**
 * One bounded LLM call over a turn that read two or more distinct sources. Fails open: fewer than two
 * sources, no reply, an error or an unparseable response all return null, so a broken check can never
 * change a reply that would have gone out today.
 */
export declare function assessSourceReliability(input: {
    question: string;
    sources: AssistantSource[];
    reply: string;
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<SourceWeighing | null>;
/** The minimal evidence-store surface this module writes to — both the harness's and the turn-local store satisfy it. */
export interface EvidenceSink {
    addObservation(evidence: {
        id: string;
        obs: string;
        reliability: SourceReliability;
        source: string;
        evidence_type: 'OBSERVATION';
        freshness: string;
    }): void;
}
/**
 * Records each assessment as an observation carrying the assessed reliability. Written straight to the
 * store's `observations` — deliberately NOT through updateWorldModel: a LOW belief weighs 0 in
 * `belief_health.support`, which could push a run into the resolver's Tier 2 DENY for a source the
 * assistant merely judged less reliable.
 */
export declare function recordSourceAssessments(store: EvidenceSink, assessments: SourceAssessment[], now?: string): void;
/** The user turn that asks the assistant to answer again with the sources weighed. */
export declare function renderSourceNote(weighing: SourceWeighing): string;
/**
 * The "Why?" lines for the sources a turn judged less reliable — one per LOW assessment recorded in the
 * claim's evidence. Empty when the check did not run or nothing was judged LOW, so a quiet turn stays quiet.
 */
export declare function lowerConfidenceSourceLines(claim: {
    evidence: Array<{
        id: string;
        obs: string;
        reliability: SourceReliability;
    }>;
}): string[];
