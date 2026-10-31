import { z } from 'zod';
/**
 * State the writer gives in chat (T13, plans/aielia_write_article_model_plan.html section 8): reviewer comments,
 * the writer's decisions about them, conflicts between comments, and corrections to facts or sources. It belongs to
 * the article, not to the conversation, so work that resumes in a new session still has it.
 *
 * Pure data and pure functions only (no node:* / DOM imports): the browser bundles this module.
 */
export declare const WRITER_CHAT_STATE_VERSION = 1;
export declare const WriterCommentSchema: z.ZodObject<{
    id: z.ZodString;
    articleId: z.ZodString;
    /** The label the writer or reviewer uses ("C1", "G2"), when there is one. Not unique across articles. */
    label: z.ZodOptional<z.ZodString>;
    reviewer: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    /** `open` covers "decided but not carried out": a decision is recorded, but the comment is only `addressed` once the text shows it. */
    state: z.ZodEnum<["open", "addressed", "dismissed"]>;
    decision: z.ZodOptional<z.ZodString>;
    /** Ids of comments that cannot be followed together with this one. Always mutual. */
    conflictsWith: z.ZodArray<z.ZodString, "many">;
    origin: z.ZodEnum<["reviewer", "writer", "assistant"]>;
    /** Where the comment applies, when it is tied to one section or claim (article model, "about" link). */
    anchor: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<["section", "claim"]>;
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "section" | "claim";
    }, {
        id: string;
        type: "section" | "claim";
    }>>;
    /** The stretch of text the writer highlighted when commenting. Found again by the quote after the text changes. */
    span: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
        quote: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        quote: string;
        start: number;
        end: number;
    }, {
        quote: string;
        start: number;
        end: number;
    }>>;
    /** The text the comment was on no longer exists as it was. The comment is kept. */
    outdated: z.ZodOptional<z.ZodBoolean>;
    /** The suggestion that addressed it, if any. */
    suggestionId: z.ZodOptional<z.ZodString>;
    capturedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    origin: "reviewer" | "assistant" | "writer";
    articleId: string;
    state: "open" | "addressed" | "dismissed";
    conflictsWith: string[];
    capturedAt: string;
    reviewer?: string | undefined;
    decision?: string | undefined;
    label?: string | undefined;
    span?: {
        quote: string;
        start: number;
        end: number;
    } | undefined;
    anchor?: {
        id: string;
        type: "section" | "claim";
    } | undefined;
    outdated?: boolean | undefined;
    suggestionId?: string | undefined;
}, {
    id: string;
    text: string;
    origin: "reviewer" | "assistant" | "writer";
    articleId: string;
    state: "open" | "addressed" | "dismissed";
    conflictsWith: string[];
    capturedAt: string;
    reviewer?: string | undefined;
    decision?: string | undefined;
    label?: string | undefined;
    span?: {
        quote: string;
        start: number;
        end: number;
    } | undefined;
    anchor?: {
        id: string;
        type: "section" | "claim";
    } | undefined;
    outdated?: boolean | undefined;
    suggestionId?: string | undefined;
}>;
export type WriterComment = z.infer<typeof WriterCommentSchema>;
/** A correction the writer states in chat. It is the "author's say-so" source kind (D2): lower-trust, and it supersedes what it names. */
export declare const WriterCorrectionSchema: z.ZodObject<{
    id: z.ZodString;
    articleId: z.ZodString;
    kind: z.ZodLiteral<"say_so">;
    trust: z.ZodLiteral<"lower">;
    /** What is now true, in the writer's terms ("p99 latency is 41 ms after a re-run"). */
    note: z.ZodString;
    /** The earlier value or source it replaces, when the writer names one. */
    supersedes: z.ZodOptional<z.ZodString>;
    capturedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    kind: "say_so";
    note: string;
    articleId: string;
    capturedAt: string;
    trust: "lower";
    supersedes?: string | undefined;
}, {
    id: string;
    kind: "say_so";
    note: string;
    articleId: string;
    capturedAt: string;
    trust: "lower";
    supersedes?: string | undefined;
}>;
export type WriterCorrection = z.infer<typeof WriterCorrectionSchema>;
export declare const WriterChatStateSchema: z.ZodObject<{
    formatVersion: z.ZodLiteral<1>;
    comments: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        articleId: z.ZodString;
        /** The label the writer or reviewer uses ("C1", "G2"), when there is one. Not unique across articles. */
        label: z.ZodOptional<z.ZodString>;
        reviewer: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        /** `open` covers "decided but not carried out": a decision is recorded, but the comment is only `addressed` once the text shows it. */
        state: z.ZodEnum<["open", "addressed", "dismissed"]>;
        decision: z.ZodOptional<z.ZodString>;
        /** Ids of comments that cannot be followed together with this one. Always mutual. */
        conflictsWith: z.ZodArray<z.ZodString, "many">;
        origin: z.ZodEnum<["reviewer", "writer", "assistant"]>;
        /** Where the comment applies, when it is tied to one section or claim (article model, "about" link). */
        anchor: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["section", "claim"]>;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            id: string;
            type: "section" | "claim";
        }, {
            id: string;
            type: "section" | "claim";
        }>>;
        /** The stretch of text the writer highlighted when commenting. Found again by the quote after the text changes. */
        span: z.ZodOptional<z.ZodObject<{
            start: z.ZodNumber;
            end: z.ZodNumber;
            quote: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            quote: string;
            start: number;
            end: number;
        }, {
            quote: string;
            start: number;
            end: number;
        }>>;
        /** The text the comment was on no longer exists as it was. The comment is kept. */
        outdated: z.ZodOptional<z.ZodBoolean>;
        /** The suggestion that addressed it, if any. */
        suggestionId: z.ZodOptional<z.ZodString>;
        capturedAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        origin: "reviewer" | "assistant" | "writer";
        articleId: string;
        state: "open" | "addressed" | "dismissed";
        conflictsWith: string[];
        capturedAt: string;
        reviewer?: string | undefined;
        decision?: string | undefined;
        label?: string | undefined;
        span?: {
            quote: string;
            start: number;
            end: number;
        } | undefined;
        anchor?: {
            id: string;
            type: "section" | "claim";
        } | undefined;
        outdated?: boolean | undefined;
        suggestionId?: string | undefined;
    }, {
        id: string;
        text: string;
        origin: "reviewer" | "assistant" | "writer";
        articleId: string;
        state: "open" | "addressed" | "dismissed";
        conflictsWith: string[];
        capturedAt: string;
        reviewer?: string | undefined;
        decision?: string | undefined;
        label?: string | undefined;
        span?: {
            quote: string;
            start: number;
            end: number;
        } | undefined;
        anchor?: {
            id: string;
            type: "section" | "claim";
        } | undefined;
        outdated?: boolean | undefined;
        suggestionId?: string | undefined;
    }>, "many">;
    corrections: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        articleId: z.ZodString;
        kind: z.ZodLiteral<"say_so">;
        trust: z.ZodLiteral<"lower">;
        /** What is now true, in the writer's terms ("p99 latency is 41 ms after a re-run"). */
        note: z.ZodString;
        /** The earlier value or source it replaces, when the writer names one. */
        supersedes: z.ZodOptional<z.ZodString>;
        capturedAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "say_so";
        note: string;
        articleId: string;
        capturedAt: string;
        trust: "lower";
        supersedes?: string | undefined;
    }, {
        id: string;
        kind: "say_so";
        note: string;
        articleId: string;
        capturedAt: string;
        trust: "lower";
        supersedes?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    comments: {
        id: string;
        text: string;
        origin: "reviewer" | "assistant" | "writer";
        articleId: string;
        state: "open" | "addressed" | "dismissed";
        conflictsWith: string[];
        capturedAt: string;
        reviewer?: string | undefined;
        decision?: string | undefined;
        label?: string | undefined;
        span?: {
            quote: string;
            start: number;
            end: number;
        } | undefined;
        anchor?: {
            id: string;
            type: "section" | "claim";
        } | undefined;
        outdated?: boolean | undefined;
        suggestionId?: string | undefined;
    }[];
    formatVersion: 1;
    corrections: {
        id: string;
        kind: "say_so";
        note: string;
        articleId: string;
        capturedAt: string;
        trust: "lower";
        supersedes?: string | undefined;
    }[];
}, {
    comments: {
        id: string;
        text: string;
        origin: "reviewer" | "assistant" | "writer";
        articleId: string;
        state: "open" | "addressed" | "dismissed";
        conflictsWith: string[];
        capturedAt: string;
        reviewer?: string | undefined;
        decision?: string | undefined;
        label?: string | undefined;
        span?: {
            quote: string;
            start: number;
            end: number;
        } | undefined;
        anchor?: {
            id: string;
            type: "section" | "claim";
        } | undefined;
        outdated?: boolean | undefined;
        suggestionId?: string | undefined;
    }[];
    formatVersion: 1;
    corrections: {
        id: string;
        kind: "say_so";
        note: string;
        articleId: string;
        capturedAt: string;
        trust: "lower";
        supersedes?: string | undefined;
    }[];
}>;
export type WriterChatState = z.infer<typeof WriterChatStateSchema>;
export interface ArticleRef {
    id: string;
    title: string;
    /** The short name shown in the header; the title is shown when there is none. */
    name?: string;
}
export declare function createEmptyWriterChatState(): WriterChatState;
/** One change the capture step proposes. `ref` is a comment id, or the label of a comment in the same article. */
export type CaptureOp = {
    op: 'add_comment';
    label?: string;
    reviewer?: string;
    text: string;
    origin?: 'reviewer' | 'writer';
} | {
    op: 'decide';
    ref: string;
    decision: string;
} | {
    op: 'conflict';
    refs: string[];
} | {
    op: 'set_state';
    ref: string;
    state: 'addressed' | 'dismissed';
} | {
    op: 'add_correction';
    note: string;
    supersedes?: string;
};
export interface ApplyResult {
    state: WriterChatState;
    /** One short line per change that was made. */
    applied: string[];
    /** One short line per op that could not be applied (unknown reference, empty text). Never silent. */
    skipped: string[];
}
/** Applies ops to the state for one article. Pure: returns a new state; the input is untouched. */
export declare function applyCaptureOps(state: WriterChatState, articleId: string, ops: readonly CaptureOp[], now: string): ApplyResult;
/**
 * The block added to the assistant's system prompt on every call: only the article under discussion, so work on one
 * article never leaks into another. Empty when there is nothing to say.
 */
export declare function renderWriterChatBlock(state: WriterChatState, articleId: string | undefined, articles: readonly ArticleRef[]): string;
