import { ToolDefinition } from '@buildaharness/runtime';
import { DigestStore, SessionDigest } from './episodic-digest.js';
/**
 * Phase M3 (agent_memory_framework_plan.html), recall half: a read-only `recall_memory` tool over
 * the episodic digests. v1 is deliberately keyword-free (D2): with no argument it returns an INDEX
 * of the most recent digests; with a digest id it returns that digest's text. The model decides
 * which digest to open, so the semantic matching is the model's, not a scorer's.
 *
 * Flag: AUDIT_RECALL_TOOL, default OFF, read only in `recallToolEnabled()`.
 *
 * The digest writer and store live in episodic-digest.ts. `DigestReader` is the seam; production
 * wraps the assistant's `DigestStore` (`storeDigestReader`). The id shown in the index is the
 * digest id exactly as `listDigests` returns it (`<sessionId>:<conversationId>`, in `sessionId`).
 */
export interface DigestReader {
    /** Most recent first, at most `limit`. */
    list(limit: number): Promise<SessionDigest[]>;
    get(id: string): Promise<SessionDigest | undefined>;
}
export declare const RECALL_INDEX_LIMIT = 20;
export declare function recallToolEnabled(env?: Record<string, string | undefined>): boolean;
export declare const RECALL_MEMORY_TOOL: ToolDefinition;
export declare const RECALL_TOOLS: ToolDefinition[];
/**
 * Runs the tool. Never throws for a bad id or a reader failure — those come back as an
 * `Error: ...` string (the loop's convention for a failed read), so the model sees them.
 */
export declare function executeRecallTool(reader: DigestReader, input: Record<string, unknown>): Promise<string>;
/** Production reader: a thin adapter over the assistant's DigestStore (`memory.digests`). Retention is applied by the store. */
export declare function storeDigestReader(store: Pick<DigestStore, 'listDigests' | 'getDigest'>): DigestReader;
/** In-memory fake for tests; takes A's SessionDigest shape. */
export declare class InMemoryDigestReader implements DigestReader {
    private readonly digests;
    constructor(digests?: SessionDigest[]);
    list(limit: number): Promise<SessionDigest[]>;
    get(id: string): Promise<SessionDigest | undefined>;
}
export declare const RECALL_POINTER_LINE = "\nEarlier sessions are summarised in memory. When the user asks what you worked on before, what was decided, or what the next step was, call the recall_memory tool (no arguments for an index, then an id to open a digest) and answer from it; the facts above are only part of what is recorded.";
/**
 * M3: the one-line pointer that tells the model the digests exist. Returned only when AUDIT_RECALL_TOOL is on AND at least one
 * digest exists, so a flag-off or digest-less run has a byte-identical prompt. No per-turn judgement: a pointer, not content.
 */
export declare function recallPointerBlock(reader: Pick<DigestReader, 'list'> | undefined): Promise<string>;
