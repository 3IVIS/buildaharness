import { ChatMessage, ILLMClient, MemoryAdapter, TokenUsage } from '@buildaharness/runtime';
import { UserFact } from './fact-extraction.js';
/**
 * Episodic tier (M3 of the agent memory framework plan): one rolling handoff digest per conversation,
 * kept apart from durable facts. Never injected into the prompt; read by the recall tool.
 *
 * STORAGE CONTRACT (the recall tool codes against this): a digest lives at `episodic:<digestId>` as a
 * `SessionDigest`. `digestId` is `<sessionId>:<conversationId>` because a CLI/chat-ui session id is
 * reused across `/new`, so a bare session id would overwrite the previous conversation's digest.
 * The id of every live digest is listed in `episodic-index` (the MemoryAdapter has no key listing).
 */
export interface SessionDigest {
    /** The digest id (the key suffix), not necessarily the raw session id: `<sessionId>:<conversationId>`. */
    sessionId: string;
    /** ISO time of the last write (the digest is rolling; retention counts from here). */
    createdAt: string;
    oneLine: string;
    objective: string;
    done: string[];
    decisions: string[];
    openItems: string[];
    nextStep: string;
    /** Set when the judge found the digest instruction-shaped. It is still untrusted context; the recall tool wraps it either way. */
    flagged?: boolean;
}
export declare const EPISODIC_KEY_PREFIX = "episodic:";
export declare const EPISODIC_INDEX_KEY = "episodic-index";
/** D4: start at 90 days, calibrate. `AUDIT_EPISODIC_RETENTION_DAYS` overrides. */
export declare const DEFAULT_RETENTION_DAYS = 90;
/** `AUDIT_EPISODIC_DIGEST`: the digest writer and the pre-compaction flush. Default OFF; `1/true/on/yes/enabled` enables. Read where the writer is invoked (assistant.ts). */
export declare function episodicDigestEnabled(env?: Record<string, string | undefined>): boolean;
export declare function episodicRetentionDays(env?: Record<string, string | undefined>): number;
/** Read side, and the owner of the digest keys. The recall tool builds one of these over the same MemoryAdapter. */
export declare class DigestStore {
    private readonly memory;
    constructor(memory: MemoryAdapter);
    private ids;
    /** One digest by id, or undefined when absent or past retention. Never writes. */
    getDigest(id: string): Promise<SessionDigest | undefined>;
    /** The most recent `limit` digests (default 10), newest first, past-retention ones excluded. Never writes. */
    listDigests(limit?: number): Promise<SessionDigest[]>;
    /** Writes one digest and prunes past-retention ones (D4). The only place episodic keys are written. */
    put(digest: SessionDigest): Promise<void>;
    pruneExpired(): Promise<number>;
    /** `/memory forget digest <id>` / `/memory forget digests` (no id). Returns how many were removed, expired ones included. */
    forget(id?: string): Promise<number>;
    /** Every stored digest, unbounded and ignoring retention, for `/memory export`. */
    exportAll(): Promise<SessionDigest[]>;
}
export declare function listDigests(memory: MemoryAdapter, limit?: number): Promise<SessionDigest[]>;
export declare function getDigest(memory: MemoryAdapter, id: string): Promise<SessionDigest | undefined>;
/** The id of `sessionId`'s current conversation, minted on first need and cleared by `endConversation` (after the final digest). */
export declare function conversationDigestId(memory: MemoryAdapter, sessionId: string): Promise<string>;
export declare function endConversation(memory: MemoryAdapter, sessionId: string): Promise<void>;
/** The marker scripted-llm-client.ts's SIDE_CALL_MARKERS keys on. */
export declare const DIGEST_SYSTEM_MARKER = "You write a session handoff digest";
type DigestBody = Omit<SessionDigest, 'sessionId' | 'createdAt' | 'flagged'>;
export interface DigestCallResult {
    body: DigestBody;
    flagged: boolean;
    facts: UserFact[];
}
/**
 * One bounded call. Returns null on any error, unparseable output, empty digest, or a MISSING secret/instruction
 * judgement — this write fails closed (a missed secret would reach disk), the one deliberate exception to "side
 * calls fail open"; the consequence of null is only that no digest is written. The whole digest goes through
 * `admitCandidate` with the gate forced on (independent of AUDIT_MEMORY_WRITE_GATE): a flagged secret is
 * replaced by the model's `redactedDigest` (an unusable redaction drops the digest).
 */
export declare function callDigest(llm: ILLMClient, input: {
    messages: ChatMessage[];
    prior?: SessionDigest;
    extractFacts: boolean;
    digestId: string;
    sessionId: string;
}, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<DigestCallResult | null>;
/**
 * Writes/refreshes the conversation's digest from `messages`, folding in whatever digest already exists. Fails open for
 * the caller (returns null, writes nothing, no partial entry). Never touches DURABLE_FACTS_KEY.
 */
export declare function writeDigest(memory: MemoryAdapter, llm: ILLMClient, args: {
    sessionId: string;
    messages: ChatMessage[];
    extractFacts: boolean;
}, model?: string, onUsage?: (usage: TokenUsage) => void): Promise<{
    digest: SessionDigest;
    facts: UserFact[];
} | null>;
export {};
