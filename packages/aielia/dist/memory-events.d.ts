import { z } from 'zod';
import { UserFact } from './fact-extraction.js';
/**
 * One record per memory transition: what changed, WHY (a closed, countable reason code) and which
 * sources justified it. Pure (no I/O, no clock): `MemoryService` builds events from the changes it
 * makes and hands them to an `EventSink`. The wire enums come from the shared contract
 * (`spec/memory-core.json`), so the Python twin sees the same names.
 *
 * Privacy: an event holds ids and codes, never fact text, unless the caller asks for images
 * (`withImages`, tied to the audit log flag). `factKey()` is a one-way id, so an event about a
 * forgotten fact reveals nothing; `scrubForgotten()` also drops the quotes and images of every
 * earlier event about it.
 */
export declare const MEMORY_EVENTS_KEY: string;
export declare const MEMORY_EVENTS_KEEP: number;
export declare const MemoryEventKindSchema: z.ZodEnum<["promote", "decline", "correct", "contradict", "supersede", "retire", "forget", "expire", "restore", "recall"]>;
export declare const ReasonCodeSchema: z.ZodEnum<["user_stated", "user_corrected", "user_confirmed", "user_rejected", "inferred_high_conf", "inferred_pending_confirmation", "inferred_low_conf_session_only", "conflicts_with_fact", "superseded_by_newer", "explicit_forget", "retention_expired", "gate_blocked_secret", "gate_blocked_instruction", "duplicate"]>;
export declare const SourceRefSchema: z.ZodObject<{
    type: z.ZodEnum<["user_message", "assistant_message", "tool_result", "prior_fact", "user_command"]>;
    /** messageId | toolCallId | factKey | command name. */
    ref: z.ZodString;
    /** Short justification the reader sees; present only with images on, and removed when the fact is forgotten. */
    quote: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "user_message" | "assistant_message" | "tool_result" | "prior_fact" | "user_command";
    ref: string;
    quote?: string | undefined;
}, {
    type: "user_message" | "assistant_message" | "tool_result" | "prior_fact" | "user_command";
    ref: string;
    quote?: string | undefined;
}>;
export declare const MemoryEventSchema: z.ZodObject<{
    seq: z.ZodNumber;
    at: z.ZodString;
    session: z.ZodString;
    turn: z.ZodString;
    kind: z.ZodEnum<["promote", "decline", "correct", "contradict", "supersede", "retire", "forget", "expire", "restore", "recall"]>;
    /** `factKey()` of the fact the event is about (the pre-image for a supersession). */
    factId: z.ZodString;
    /** `factKey()` of the replacement, for a supersession. */
    afterFactId: z.ZodOptional<z.ZodString>;
    attributeKey: z.ZodOptional<z.ZodString>;
    store: z.ZodOptional<z.ZodEnum<["durable", "pending", "rejected", "session"]>>;
    before: z.ZodOptional<z.ZodObject<{
        text: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>>;
    after: z.ZodOptional<z.ZodObject<{
        text: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>>;
    reason: z.ZodEnum<["user_stated", "user_corrected", "user_confirmed", "user_rejected", "inferred_high_conf", "inferred_pending_confirmation", "inferred_low_conf_session_only", "conflicts_with_fact", "superseded_by_newer", "explicit_forget", "retention_expired", "gate_blocked_secret", "gate_blocked_instruction", "duplicate"]>;
    sources: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["user_message", "assistant_message", "tool_result", "prior_fact", "user_command"]>;
        /** messageId | toolCallId | factKey | command name. */
        ref: z.ZodString;
        /** Short justification the reader sees; present only with images on, and removed when the fact is forgotten. */
        quote: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "user_message" | "assistant_message" | "tool_result" | "prior_fact" | "user_command";
        ref: string;
        quote?: string | undefined;
    }, {
        type: "user_message" | "assistant_message" | "tool_result" | "prior_fact" | "user_command";
        ref: string;
        quote?: string | undefined;
    }>, "many">;
    decidedBy: z.ZodEnum<["user", "classifier", "reviewer", "consolidation", "rule"]>;
    confidence: z.ZodOptional<z.ZodEnum<["high", "medium", "low"]>>;
    group: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    at: string;
    kind: "retire" | "restore" | "promote" | "decline" | "correct" | "contradict" | "supersede" | "forget" | "expire" | "recall";
    reason: "user_stated" | "user_corrected" | "user_confirmed" | "user_rejected" | "inferred_high_conf" | "inferred_pending_confirmation" | "inferred_low_conf_session_only" | "conflicts_with_fact" | "superseded_by_newer" | "explicit_forget" | "retention_expired" | "gate_blocked_secret" | "gate_blocked_instruction" | "duplicate";
    session: string;
    seq: number;
    factId: string;
    turn: string;
    sources: {
        type: "user_message" | "assistant_message" | "tool_result" | "prior_fact" | "user_command";
        ref: string;
        quote?: string | undefined;
    }[];
    decidedBy: "reviewer" | "rule" | "user" | "consolidation" | "classifier";
    confidence?: "high" | "medium" | "low" | undefined;
    before?: z.objectOutputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    after?: z.objectOutputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    store?: "rejected" | "durable" | "pending" | "session" | undefined;
    group?: string | undefined;
    afterFactId?: string | undefined;
    attributeKey?: string | undefined;
}, {
    at: string;
    kind: "retire" | "restore" | "promote" | "decline" | "correct" | "contradict" | "supersede" | "forget" | "expire" | "recall";
    reason: "user_stated" | "user_corrected" | "user_confirmed" | "user_rejected" | "inferred_high_conf" | "inferred_pending_confirmation" | "inferred_low_conf_session_only" | "conflicts_with_fact" | "superseded_by_newer" | "explicit_forget" | "retention_expired" | "gate_blocked_secret" | "gate_blocked_instruction" | "duplicate";
    session: string;
    seq: number;
    factId: string;
    turn: string;
    sources: {
        type: "user_message" | "assistant_message" | "tool_result" | "prior_fact" | "user_command";
        ref: string;
        quote?: string | undefined;
    }[];
    decidedBy: "reviewer" | "rule" | "user" | "consolidation" | "classifier";
    confidence?: "high" | "medium" | "low" | undefined;
    before?: z.objectInputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    after?: z.objectInputType<{
        text: z.ZodString;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    store?: "rejected" | "durable" | "pending" | "session" | undefined;
    group?: string | undefined;
    afterFactId?: string | undefined;
    attributeKey?: string | undefined;
}>;
export type MemoryEventKind = z.infer<typeof MemoryEventKindSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;
export type MemoryEventDraft = Omit<MemoryEvent, 'seq' | 'at'>;
export interface EventSink {
    emit(events: MemoryEvent[]): void | Promise<void>;
}
export declare class InMemoryEventSink implements EventSink {
    readonly events: MemoryEvent[];
    emit(events: MemoryEvent[]): void;
}
/** Stable, non-reversible id for a fact (FNV-1a over `text|extractedAt`): lets events point at a fact without carrying its words. */
export declare function factKey(fact: Pick<UserFact, 'text' | 'extractedAt'>): string;
export declare function keyOfFactId(id: string): string;
/** The slice of an audit entry an event is derived from (structural, so this module never imports the service). */
export interface AuditLike {
    op: 'add' | 'replace' | 'retire' | 'remove' | 'confirm' | 'reject' | 'undo' | 'archive' | 'restore';
    factId: string;
    before?: UserFact;
    after?: UserFact;
    store: 'durable' | 'pending' | 'rejected';
    writer: string;
    turn: string;
    group?: string;
}
/** Project one audit change onto its event: kind, reason, decider and sources, from the op, the writer and the fact's own provenance bits (never its wording). */
export declare function eventFromAudit(a: AuditLike, withImages: boolean): MemoryEventDraft;
/** Drops quotes and images from every earlier event about a forgotten fact, so the log cannot be used to read it back. */
export declare function scrubForgotten(log: MemoryEvent[], forgottenKeys: Set<string>): MemoryEvent[];
/** Keeps the newest `keep` events. */
export declare function trimEvents(log: MemoryEvent[], keep?: number): MemoryEvent[];
/**
 * Replays an event stream from empty and returns the ids of the durable facts, in order. This is
 * the correctness check for the log: it must equal `factKey()` over the stored durable list.
 * `unsupported` counts events it cannot replay (an undo reinserts at a recorded position).
 */
export declare function foldDurable(events: MemoryEvent[]): {
    ids: string[];
    unsupported: number;
};
export interface EventFilter {
    /** A fact id as printed by `formatMemoryEvents` (`f_xxxxxxxx`), or an attribute key. */
    fact?: string;
    kind?: MemoryEventKind;
}
export declare function filterEvents(events: MemoryEvent[], f?: EventFilter): MemoryEvent[];
/** `/memory history events [fact]`: one line per event, with the reason and its sources. Shared by the CLI and chat-ui. */
export declare function formatMemoryEvents(events: MemoryEvent[]): string;
