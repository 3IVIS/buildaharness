import { ChatMessage, ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * AL3a — semantic pre-staging scope check. Root cause it addresses: the classifier gates a
 * consequential request on *risk*, never on whether the request is *determinate*, and the tool loop
 * stages whatever action the proposer guesses (write_file/run_shell_command stage unconditionally). So
 * "Clear out the old ones." reached `needs_approval` with a guessed deletion — the approval prompt then
 * authorizes a guess instead of resolving it. The system prompt's "ask when genuinely ambiguous" is
 * advisory and the proposer ignores it once a tool is in reach.
 *
 * This is one bounded LLM call, made only on consequential turns and only when the guard flag is
 * enabled — a semantic judgment, not a lexical gate (AL-2). It fails open to "not ambiguous": staging
 * and the approval gate remain the safety net, so a failed check never blocks a clear request.
 */
export interface AmbiguityCheck {
    ambiguous: boolean;
    /** One concrete clarifying question; only meaningful when `ambiguous`. */
    question: string;
}
export declare function parseAmbiguityCheck(content: string): AmbiguityCheck | null;
export declare function checkRequestAmbiguity(message: string, llmClient: ILLMClient, recentTranscript: ChatMessage[], model?: string, onUsage?: (usage: TokenUsage) => void): Promise<AmbiguityCheck>;
