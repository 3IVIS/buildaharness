import { ChatMessage, ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * `AUDIT_SEMANTIC_COMPACTION` gate. Default **OFF**: once a transcript is long, transcript-compaction.ts keeps the
 * first 200 characters of each older message and nothing else, so a detail deep in an earlier message (a pasted
 * document, a long answer) is gone from what the model sees — and the model has no tool to search the message index.
 * On, ONE bounded call writes the summary instead (see summarizeOlderMessages); any failure falls back to the
 * truncated form. Costs one call each time the thresholds trip. A truthy value (`1` / `true` / `on` / `yes` /
 * `enabled`) enables it. Read at exactly one site: assistant.ts.
 */
export declare function semanticCompactionEnabled(env?: Record<string, string | undefined>): boolean;
/**
 * One bounded LLM call: the older messages of a long conversation, condensed with their specifics kept. Returns null
 * — the caller then uses the truncated form — on any error, an empty or unparseable answer, or input too large.
 */
export declare function summarizeOlderMessages(older: ChatMessage[], llmClient: ILLMClient, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<string | null>;
