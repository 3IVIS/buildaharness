import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { SemanticHypothesisProposal } from '@buildaharness/harness';
/** Marks a proposer-facing note that carries competing explanations (see AgentLoop.createHarnessProposer). */
export declare const HYPOTHESIS_NOTE_PREFIX = "[hypotheses] ";
/**
 * `AUDIT_SEMANTIC_HYPOTHESES` gate. Default **OFF**: hypotheses stay the template seeds the harness generates and
 * nothing is shown to the model. A truthy value (`1` / `true` / `on` / `yes` / `enabled`) lets the harness ask, once
 * per turn, for competing explanations of a request the classifier judged underdetermined, judge them against the
 * evidence each execution gathers, and put them in front of the proposer. It changes what the assistant says, so it
 * ships off until a benchmark shows it helps. Read at one site: harness-bridge.ts.
 */
export declare function semanticHypothesesEnabled(env?: Record<string, string | undefined>): boolean;
/** One bounded LLM call: 2-4 competing explanations, or none. Fails open — any error or unusable answer is null. */
export declare function proposeCompetingExplanations(input: {
    request: string;
    observations: string[];
    beliefs: string[];
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<SemanticHypothesisProposal[] | null>;
/** One bounded LLM call: which of the explanations do these observations rule out? Fails open — null. */
export declare function judgeHypothesesAgainstEvidence(input: {
    hypotheses: Array<{
        id: string;
        explanation: string;
        predicted_observations: string[];
    }>;
    observations: string[];
}, llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<{
    contradicted: Array<{
        id: string;
        reason?: string;
    }>;
} | null>;
/** The proposer-facing note: the competing explanations and what would tell them apart. */
export declare function renderHypothesisNote(hypotheses: Array<{
    explanation: string;
    predicted_observations: string[];
    separating_check?: string;
}>): string;
/** The user turn the proposer sees for a hypothesis note (the note text without its prefix). */
export declare function hypothesisContextMessage(noteBody: string): string;
