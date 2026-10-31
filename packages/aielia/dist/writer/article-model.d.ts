import { z } from 'zod';
/**
 * The article model (plans/aielia_write_article_model_plan.html, sections 2-5): everything about an article that is not
 * its text. It is the content of `article.meta.json`; the text stays ordinary Markdown in `article.md`.
 * Pure data, no node:* / DOM imports: the browser bundles it.
 */
export declare const ARTICLE_META_VERSION = 1;
export declare const ReviewStateSchema: z.ZodEnum<["clean", "needs_review", "being_revised", "held"]>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export declare const SectionSchema: z.ZodObject<{
    id: z.ZodString;
    heading: z.ZodString;
    level: z.ZodNumber;
    order: z.ZodNumber;
    parentId: z.ZodOptional<z.ZodString>;
    /** What this section is for, in a line (used by the outline). */
    purpose: z.ZodOptional<z.ZodString>;
    /** Character offsets into article.md: [start, end). */
    span: z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        start: number;
        end: number;
    }, {
        start: number;
        end: number;
    }>;
    review: z.ZodObject<{
        state: z.ZodEnum<["clean", "needs_review", "being_revised", "held"]>;
        reason: z.ZodOptional<z.ZodString>;
        setBy: z.ZodOptional<z.ZodEnum<["resolver", "writer", "editor"]>>;
        at: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        state: "clean" | "needs_review" | "being_revised" | "held";
        at?: string | undefined;
        reason?: string | undefined;
        setBy?: "writer" | "resolver" | "editor" | undefined;
    }, {
        state: "clean" | "needs_review" | "being_revised" | "held";
        at?: string | undefined;
        reason?: string | undefined;
        setBy?: "writer" | "resolver" | "editor" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    id: string;
    review: {
        state: "clean" | "needs_review" | "being_revised" | "held";
        at?: string | undefined;
        reason?: string | undefined;
        setBy?: "writer" | "resolver" | "editor" | undefined;
    };
    span: {
        start: number;
        end: number;
    };
    heading: string;
    level: number;
    order: number;
    parentId?: string | undefined;
    purpose?: string | undefined;
}, {
    id: string;
    review: {
        state: "clean" | "needs_review" | "being_revised" | "held";
        at?: string | undefined;
        reason?: string | undefined;
        setBy?: "writer" | "resolver" | "editor" | undefined;
    };
    span: {
        start: number;
        end: number;
    };
    heading: string;
    level: number;
    order: number;
    parentId?: string | undefined;
    purpose?: string | undefined;
}>;
export type Section = z.infer<typeof SectionSchema>;
export declare const SourceStatusSchema: z.ZodEnum<["none", "attached", "supported", "partly_supported", "not_supported", "contradicted", "stale", "not_checked"]>;
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export declare const ClaimSchema: z.ZodObject<{
    id: z.ZodString;
    sectionId: z.ZodString;
    /** The text the claim came from, quoted, so it can be found again after edits. */
    quote: z.ZodString;
    /** Approximate offset of the quote in article.md. */
    position: z.ZodNumber;
    /** `opinion` and `framing` are statements the writer marked as not needing a source. */
    kind: z.ZodEnum<["factual", "opinion", "framing"]>;
    author: z.ZodEnum<["model", "writer", "mixed"]>;
    authorAt: z.ZodString;
    /** A confirmed claim is matched first on re-extraction and never dropped silently. */
    confirmed: z.ZodBoolean;
    /** What the last check said. Whether it still counts is decided by `effectiveSourceStatus`, never by this field alone. */
    sourceStatus: z.ZodEnum<["none", "attached", "supported", "partly_supported", "not_supported", "contradicted", "stale", "not_checked"]>;
    check: z.ZodOptional<z.ZodObject<{
        ranAt: z.ZodString;
        model: z.ZodString;
        reason: z.ZodString;
        /** The claim text and the source fingerprints the check ran against. */
        claimText: z.ZodString;
        sourceFingerprints: z.ZodRecord<z.ZodString, z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        model: string;
        reason: string;
        ranAt: string;
        claimText: string;
        sourceFingerprints: Record<string, string>;
    }, {
        model: string;
        reason: string;
        ranAt: string;
        claimText: string;
        sourceFingerprints: Record<string, string>;
    }>>;
    /** Set when re-anchoring was unsure: "moved or changed, check". */
    needsRecheck: z.ZodOptional<z.ZodBoolean>;
    /** The last time a source was looked for and not found, kept so the page can say so. It only counts while `claimText` is still the claim's text. */
    lookup: z.ZodOptional<z.ZodObject<{
        at: z.ZodString;
        claimText: z.ZodString;
        outcome: z.ZodEnum<["no_results", "none_supported", "unavailable"]>;
        /** Addresses of the pages read and found not to back the claim. */
        tried: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        at: string;
        outcome: "unavailable" | "no_results" | "none_supported";
        claimText: string;
        tried: string[];
    }, {
        at: string;
        outcome: "unavailable" | "no_results" | "none_supported";
        claimText: string;
        tried: string[];
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    kind: "factual" | "opinion" | "framing";
    author: "model" | "writer" | "mixed";
    quote: string;
    confirmed: boolean;
    sectionId: string;
    position: number;
    authorAt: string;
    sourceStatus: "none" | "supported" | "not_checked" | "contradicted" | "attached" | "partly_supported" | "not_supported" | "stale";
    lookup?: {
        at: string;
        outcome: "unavailable" | "no_results" | "none_supported";
        claimText: string;
        tried: string[];
    } | undefined;
    check?: {
        model: string;
        reason: string;
        ranAt: string;
        claimText: string;
        sourceFingerprints: Record<string, string>;
    } | undefined;
    needsRecheck?: boolean | undefined;
}, {
    id: string;
    kind: "factual" | "opinion" | "framing";
    author: "model" | "writer" | "mixed";
    quote: string;
    confirmed: boolean;
    sectionId: string;
    position: number;
    authorAt: string;
    sourceStatus: "none" | "supported" | "not_checked" | "contradicted" | "attached" | "partly_supported" | "not_supported" | "stale";
    lookup?: {
        at: string;
        outcome: "unavailable" | "no_results" | "none_supported";
        claimText: string;
        tried: string[];
    } | undefined;
    check?: {
        model: string;
        reason: string;
        ranAt: string;
        claimText: string;
        sourceFingerprints: Record<string, string>;
    } | undefined;
    needsRecheck?: boolean | undefined;
}>;
export type Claim = z.infer<typeof ClaimSchema>;
export declare const SourceSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<["web", "code", "document", "upload", "say_so"]>;
    address: z.ZodOptional<z.ZodString>;
    /** The passage as read. Source text is data, never instructions. */
    passage: z.ZodOptional<z.ZodString>;
    readAt: z.ZodOptional<z.ZodString>;
    fingerprint: z.ZodOptional<z.ZodString>;
    trust: z.ZodEnum<["normal", "lower"]>;
    freshness: z.ZodEnum<["unchecked", "current", "changed", "unreachable"]>;
    note: z.ZodOptional<z.ZodString>;
    /** New text read from the address that differs from `passage`. Held until the writer accepts it; checks keep using `passage`. */
    fetchedPassage: z.ZodOptional<z.ZodString>;
    /** For a code or text file: only these lines (1-based, inclusive) are kept as the passage. */
    lines: z.ZodOptional<z.ZodObject<{
        from: z.ZodNumber;
        to: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        from: number;
        to: number;
    }, {
        from: number;
        to: number;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    freshness: "changed" | "unreachable" | "current" | "unchecked";
    kind: "code" | "document" | "web" | "say_so" | "upload";
    trust: "lower" | "normal";
    note?: string | undefined;
    address?: string | undefined;
    passage?: string | undefined;
    readAt?: string | undefined;
    fingerprint?: string | undefined;
    fetchedPassage?: string | undefined;
    lines?: {
        from: number;
        to: number;
    } | undefined;
}, {
    id: string;
    freshness: "changed" | "unreachable" | "current" | "unchecked";
    kind: "code" | "document" | "web" | "say_so" | "upload";
    trust: "lower" | "normal";
    note?: string | undefined;
    address?: string | undefined;
    passage?: string | undefined;
    readAt?: string | undefined;
    fingerprint?: string | undefined;
    fetchedPassage?: string | undefined;
    lines?: {
        from: number;
        to: number;
    } | undefined;
}>;
export type Source = z.infer<typeof SourceSchema>;
export declare const LinkEndSchema: z.ZodObject<{
    type: z.ZodEnum<["section", "claim", "source", "comment"]>;
    id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    type: "source" | "section" | "claim" | "comment";
}, {
    id: string;
    type: "source" | "section" | "claim" | "comment";
}>;
export declare const LinkSchema: z.ZodObject<{
    id: z.ZodString;
    from: z.ZodObject<{
        type: z.ZodEnum<["section", "claim", "source", "comment"]>;
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    }, {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    }>;
    to: z.ZodObject<{
        type: z.ZodEnum<["section", "claim", "source", "comment"]>;
        id: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    }, {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    }>;
    /** A recorded value, not a fixed set: the kinds are expected to grow. Starting kinds: rests_on, supported_by, repeats, about. */
    kind: z.ZodString;
    origin: z.ZodEnum<["proposed", "confirmed", "drawn"]>;
    confidence: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodOptional<z.ZodString>;
    at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    at: string;
    id: string;
    from: {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    };
    to: {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    };
    kind: string;
    origin: "proposed" | "confirmed" | "drawn";
    confidence?: number | undefined;
    reason?: string | undefined;
}, {
    at: string;
    id: string;
    from: {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    };
    to: {
        id: string;
        type: "source" | "section" | "claim" | "comment";
    };
    kind: string;
    origin: "proposed" | "confirmed" | "drawn";
    confidence?: number | undefined;
    reason?: string | undefined;
}>;
export type Link = z.infer<typeof LinkSchema>;
export declare const SuggestionSchema: z.ZodObject<{
    id: z.ZodString;
    span: z.ZodObject<{
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
    }>;
    replacement: z.ZodString;
    reason: z.ZodString;
    proposedBy: z.ZodEnum<["assistant", "writer"]>;
    /** The model that proposed it, when the assistant did. */
    model: z.ZodOptional<z.ZodString>;
    /** Ideas that this suggestion writes into the text; they are marked used when it is accepted. */
    ideaIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Reviewer comments this suggestion was written to address; they are marked addressed when it is accepted. */
    commentIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Sections this suggestion brings in line; their review mark is cleared when it is accepted. */
    sectionIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    state: z.ZodEnum<["pending", "accepted", "rejected", "edited_accepted", "stale"]>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    reason: string;
    createdAt: string;
    span: {
        quote: string;
        start: number;
        end: number;
    };
    state: "rejected" | "pending" | "stale" | "accepted" | "edited_accepted";
    replacement: string;
    proposedBy: "assistant" | "writer";
    model?: string | undefined;
    ideaIds?: string[] | undefined;
    commentIds?: string[] | undefined;
    sectionIds?: string[] | undefined;
}, {
    id: string;
    reason: string;
    createdAt: string;
    span: {
        quote: string;
        start: number;
        end: number;
    };
    state: "rejected" | "pending" | "stale" | "accepted" | "edited_accepted";
    replacement: string;
    proposedBy: "assistant" | "writer";
    model?: string | undefined;
    ideaIds?: string[] | undefined;
    commentIds?: string[] | undefined;
    sectionIds?: string[] | undefined;
}>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
/** The reusable brief for one article: who it is for and what it should do. Every field is optional text the writer fills in. */
export declare const BriefSchema: z.ZodObject<{
    audience: z.ZodOptional<z.ZodString>;
    purpose: z.ZodOptional<z.ZodString>;
    tone: z.ZodOptional<z.ZodString>;
    length: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    length?: string | undefined;
    notes?: string | undefined;
    purpose?: string | undefined;
    audience?: string | undefined;
    tone?: string | undefined;
}, {
    length?: string | undefined;
    notes?: string | undefined;
    purpose?: string | undefined;
    audience?: string | undefined;
    tone?: string | undefined;
}>;
export type Brief = z.infer<typeof BriefSchema>;
/** A writing profile (brand voice and terminology). A copy lives in each article that uses it, so an export is self-contained. */
export declare const StyleProfileSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    voice: z.ZodDefault<z.ZodString>;
    /** Words the writer wants used, and the words they replace. */
    terms: z.ZodDefault<z.ZodArray<z.ZodObject<{
        use: z.ZodString;
        instead: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        use: string;
        instead?: string | undefined;
    }, {
        use: string;
        instead?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    voice: string;
    terms: {
        use: string;
        instead?: string | undefined;
    }[];
}, {
    id: string;
    name: string;
    voice?: string | undefined;
    terms?: {
        use: string;
        instead?: string | undefined;
    }[] | undefined;
}>;
export type StyleProfile = z.infer<typeof StyleProfileSchema>;
export declare const IdeaSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    /** Who added it. When the assistant did, `model` says which model. */
    origin: z.ZodEnum<["writer", "assistant"]>;
    model: z.ZodOptional<z.ZodString>;
    /** The section it is meant for, if the writer or the assistant said so. */
    sectionId: z.ZodOptional<z.ZodString>;
    /** open: not in the text yet. used: written into the article. dropped: set aside. */
    state: z.ZodEnum<["open", "used", "dropped"]>;
    usedIn: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    text: string;
    origin: "assistant" | "writer";
    createdAt: string;
    state: "used" | "dropped" | "open";
    model?: string | undefined;
    sectionId?: string | undefined;
    usedIn?: string | undefined;
}, {
    id: string;
    text: string;
    origin: "assistant" | "writer";
    createdAt: string;
    state: "used" | "dropped" | "open";
    model?: string | undefined;
    sectionId?: string | undefined;
    usedIn?: string | undefined;
}>;
export type Idea = z.infer<typeof IdeaSchema>;
export declare const ArticleMetaSchema: z.ZodObject<{
    formatVersion: z.ZodNumber;
    id: z.ZodString;
    title: z.ZodString;
    /** The short name the writer files the article under (shown in the page header). Separate from the title, which is the first heading of the text. */
    name: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["drafting", "ready", "published"]>;
    sections: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        heading: z.ZodString;
        level: z.ZodNumber;
        order: z.ZodNumber;
        parentId: z.ZodOptional<z.ZodString>;
        /** What this section is for, in a line (used by the outline). */
        purpose: z.ZodOptional<z.ZodString>;
        /** Character offsets into article.md: [start, end). */
        span: z.ZodObject<{
            start: z.ZodNumber;
            end: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            start: number;
            end: number;
        }, {
            start: number;
            end: number;
        }>;
        review: z.ZodObject<{
            state: z.ZodEnum<["clean", "needs_review", "being_revised", "held"]>;
            reason: z.ZodOptional<z.ZodString>;
            setBy: z.ZodOptional<z.ZodEnum<["resolver", "writer", "editor"]>>;
            at: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            state: "clean" | "needs_review" | "being_revised" | "held";
            at?: string | undefined;
            reason?: string | undefined;
            setBy?: "writer" | "resolver" | "editor" | undefined;
        }, {
            state: "clean" | "needs_review" | "being_revised" | "held";
            at?: string | undefined;
            reason?: string | undefined;
            setBy?: "writer" | "resolver" | "editor" | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        review: {
            state: "clean" | "needs_review" | "being_revised" | "held";
            at?: string | undefined;
            reason?: string | undefined;
            setBy?: "writer" | "resolver" | "editor" | undefined;
        };
        span: {
            start: number;
            end: number;
        };
        heading: string;
        level: number;
        order: number;
        parentId?: string | undefined;
        purpose?: string | undefined;
    }, {
        id: string;
        review: {
            state: "clean" | "needs_review" | "being_revised" | "held";
            at?: string | undefined;
            reason?: string | undefined;
            setBy?: "writer" | "resolver" | "editor" | undefined;
        };
        span: {
            start: number;
            end: number;
        };
        heading: string;
        level: number;
        order: number;
        parentId?: string | undefined;
        purpose?: string | undefined;
    }>, "many">;
    claims: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        sectionId: z.ZodString;
        /** The text the claim came from, quoted, so it can be found again after edits. */
        quote: z.ZodString;
        /** Approximate offset of the quote in article.md. */
        position: z.ZodNumber;
        /** `opinion` and `framing` are statements the writer marked as not needing a source. */
        kind: z.ZodEnum<["factual", "opinion", "framing"]>;
        author: z.ZodEnum<["model", "writer", "mixed"]>;
        authorAt: z.ZodString;
        /** A confirmed claim is matched first on re-extraction and never dropped silently. */
        confirmed: z.ZodBoolean;
        /** What the last check said. Whether it still counts is decided by `effectiveSourceStatus`, never by this field alone. */
        sourceStatus: z.ZodEnum<["none", "attached", "supported", "partly_supported", "not_supported", "contradicted", "stale", "not_checked"]>;
        check: z.ZodOptional<z.ZodObject<{
            ranAt: z.ZodString;
            model: z.ZodString;
            reason: z.ZodString;
            /** The claim text and the source fingerprints the check ran against. */
            claimText: z.ZodString;
            sourceFingerprints: z.ZodRecord<z.ZodString, z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            model: string;
            reason: string;
            ranAt: string;
            claimText: string;
            sourceFingerprints: Record<string, string>;
        }, {
            model: string;
            reason: string;
            ranAt: string;
            claimText: string;
            sourceFingerprints: Record<string, string>;
        }>>;
        /** Set when re-anchoring was unsure: "moved or changed, check". */
        needsRecheck: z.ZodOptional<z.ZodBoolean>;
        /** The last time a source was looked for and not found, kept so the page can say so. It only counts while `claimText` is still the claim's text. */
        lookup: z.ZodOptional<z.ZodObject<{
            at: z.ZodString;
            claimText: z.ZodString;
            outcome: z.ZodEnum<["no_results", "none_supported", "unavailable"]>;
            /** Addresses of the pages read and found not to back the claim. */
            tried: z.ZodArray<z.ZodString, "many">;
        }, "strip", z.ZodTypeAny, {
            at: string;
            outcome: "unavailable" | "no_results" | "none_supported";
            claimText: string;
            tried: string[];
        }, {
            at: string;
            outcome: "unavailable" | "no_results" | "none_supported";
            claimText: string;
            tried: string[];
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        kind: "factual" | "opinion" | "framing";
        author: "model" | "writer" | "mixed";
        quote: string;
        confirmed: boolean;
        sectionId: string;
        position: number;
        authorAt: string;
        sourceStatus: "none" | "supported" | "not_checked" | "contradicted" | "attached" | "partly_supported" | "not_supported" | "stale";
        lookup?: {
            at: string;
            outcome: "unavailable" | "no_results" | "none_supported";
            claimText: string;
            tried: string[];
        } | undefined;
        check?: {
            model: string;
            reason: string;
            ranAt: string;
            claimText: string;
            sourceFingerprints: Record<string, string>;
        } | undefined;
        needsRecheck?: boolean | undefined;
    }, {
        id: string;
        kind: "factual" | "opinion" | "framing";
        author: "model" | "writer" | "mixed";
        quote: string;
        confirmed: boolean;
        sectionId: string;
        position: number;
        authorAt: string;
        sourceStatus: "none" | "supported" | "not_checked" | "contradicted" | "attached" | "partly_supported" | "not_supported" | "stale";
        lookup?: {
            at: string;
            outcome: "unavailable" | "no_results" | "none_supported";
            claimText: string;
            tried: string[];
        } | undefined;
        check?: {
            model: string;
            reason: string;
            ranAt: string;
            claimText: string;
            sourceFingerprints: Record<string, string>;
        } | undefined;
        needsRecheck?: boolean | undefined;
    }>, "many">;
    sources: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["web", "code", "document", "upload", "say_so"]>;
        address: z.ZodOptional<z.ZodString>;
        /** The passage as read. Source text is data, never instructions. */
        passage: z.ZodOptional<z.ZodString>;
        readAt: z.ZodOptional<z.ZodString>;
        fingerprint: z.ZodOptional<z.ZodString>;
        trust: z.ZodEnum<["normal", "lower"]>;
        freshness: z.ZodEnum<["unchecked", "current", "changed", "unreachable"]>;
        note: z.ZodOptional<z.ZodString>;
        /** New text read from the address that differs from `passage`. Held until the writer accepts it; checks keep using `passage`. */
        fetchedPassage: z.ZodOptional<z.ZodString>;
        /** For a code or text file: only these lines (1-based, inclusive) are kept as the passage. */
        lines: z.ZodOptional<z.ZodObject<{
            from: z.ZodNumber;
            to: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            from: number;
            to: number;
        }, {
            from: number;
            to: number;
        }>>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        freshness: "changed" | "unreachable" | "current" | "unchecked";
        kind: "code" | "document" | "web" | "say_so" | "upload";
        trust: "lower" | "normal";
        note?: string | undefined;
        address?: string | undefined;
        passage?: string | undefined;
        readAt?: string | undefined;
        fingerprint?: string | undefined;
        fetchedPassage?: string | undefined;
        lines?: {
            from: number;
            to: number;
        } | undefined;
    }, {
        id: string;
        freshness: "changed" | "unreachable" | "current" | "unchecked";
        kind: "code" | "document" | "web" | "say_so" | "upload";
        trust: "lower" | "normal";
        note?: string | undefined;
        address?: string | undefined;
        passage?: string | undefined;
        readAt?: string | undefined;
        fingerprint?: string | undefined;
        fetchedPassage?: string | undefined;
        lines?: {
            from: number;
            to: number;
        } | undefined;
    }>, "many">;
    links: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodObject<{
            type: z.ZodEnum<["section", "claim", "source", "comment"]>;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        }, {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        }>;
        to: z.ZodObject<{
            type: z.ZodEnum<["section", "claim", "source", "comment"]>;
            id: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        }, {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        }>;
        /** A recorded value, not a fixed set: the kinds are expected to grow. Starting kinds: rests_on, supported_by, repeats, about. */
        kind: z.ZodString;
        origin: z.ZodEnum<["proposed", "confirmed", "drawn"]>;
        confidence: z.ZodOptional<z.ZodNumber>;
        reason: z.ZodOptional<z.ZodString>;
        at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        at: string;
        id: string;
        from: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        to: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        kind: string;
        origin: "proposed" | "confirmed" | "drawn";
        confidence?: number | undefined;
        reason?: string | undefined;
    }, {
        at: string;
        id: string;
        from: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        to: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        kind: string;
        origin: "proposed" | "confirmed" | "drawn";
        confidence?: number | undefined;
        reason?: string | undefined;
    }>, "many">;
    comments: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        articleId: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
        reviewer: z.ZodOptional<z.ZodString>;
        text: z.ZodString;
        state: z.ZodEnum<["open", "addressed", "dismissed"]>;
        decision: z.ZodOptional<z.ZodString>;
        conflictsWith: z.ZodArray<z.ZodString, "many">;
        origin: z.ZodEnum<["reviewer", "writer", "assistant"]>;
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
        outdated: z.ZodOptional<z.ZodBoolean>;
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
    /** Corrections the writer gave in chat (author's say-so). */
    corrections: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        articleId: z.ZodString;
        kind: z.ZodLiteral<"say_so">;
        trust: z.ZodLiteral<"lower">;
        note: z.ZodString;
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
    suggestions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        span: z.ZodObject<{
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
        }>;
        replacement: z.ZodString;
        reason: z.ZodString;
        proposedBy: z.ZodEnum<["assistant", "writer"]>;
        /** The model that proposed it, when the assistant did. */
        model: z.ZodOptional<z.ZodString>;
        /** Ideas that this suggestion writes into the text; they are marked used when it is accepted. */
        ideaIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        /** Reviewer comments this suggestion was written to address; they are marked addressed when it is accepted. */
        commentIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        /** Sections this suggestion brings in line; their review mark is cleared when it is accepted. */
        sectionIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        state: z.ZodEnum<["pending", "accepted", "rejected", "edited_accepted", "stale"]>;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        reason: string;
        createdAt: string;
        span: {
            quote: string;
            start: number;
            end: number;
        };
        state: "rejected" | "pending" | "stale" | "accepted" | "edited_accepted";
        replacement: string;
        proposedBy: "assistant" | "writer";
        model?: string | undefined;
        ideaIds?: string[] | undefined;
        commentIds?: string[] | undefined;
        sectionIds?: string[] | undefined;
    }, {
        id: string;
        reason: string;
        createdAt: string;
        span: {
            quote: string;
            start: number;
            end: number;
        };
        state: "rejected" | "pending" | "stale" | "accepted" | "edited_accepted";
        replacement: string;
        proposedBy: "assistant" | "writer";
        model?: string | undefined;
        ideaIds?: string[] | undefined;
        commentIds?: string[] | undefined;
        sectionIds?: string[] | undefined;
    }>, "many">;
    /** Ideas: material the writer or the assistant collected, to be written into the article. */
    ideas: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        /** Who added it. When the assistant did, `model` says which model. */
        origin: z.ZodEnum<["writer", "assistant"]>;
        model: z.ZodOptional<z.ZodString>;
        /** The section it is meant for, if the writer or the assistant said so. */
        sectionId: z.ZodOptional<z.ZodString>;
        /** open: not in the text yet. used: written into the article. dropped: set aside. */
        state: z.ZodEnum<["open", "used", "dropped"]>;
        usedIn: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        text: string;
        origin: "assistant" | "writer";
        createdAt: string;
        state: "used" | "dropped" | "open";
        model?: string | undefined;
        sectionId?: string | undefined;
        usedIn?: string | undefined;
    }, {
        id: string;
        text: string;
        origin: "assistant" | "writer";
        createdAt: string;
        state: "used" | "dropped" | "open";
        model?: string | undefined;
        sectionId?: string | undefined;
        usedIn?: string | undefined;
    }>, "many">>;
    /** The writer's free notes for this article: one block of text to click into and edit. */
    scratchpad: z.ZodOptional<z.ZodString>;
    /** The brief and the writing profile the assistant follows when it proposes text. */
    brief: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodString>;
        purpose: z.ZodOptional<z.ZodString>;
        tone: z.ZodOptional<z.ZodString>;
        length: z.ZodOptional<z.ZodString>;
        notes: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        length?: string | undefined;
        notes?: string | undefined;
        purpose?: string | undefined;
        audience?: string | undefined;
        tone?: string | undefined;
    }, {
        length?: string | undefined;
        notes?: string | undefined;
        purpose?: string | undefined;
        audience?: string | undefined;
        tone?: string | undefined;
    }>>;
    style: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        voice: z.ZodDefault<z.ZodString>;
        /** Words the writer wants used, and the words they replace. */
        terms: z.ZodDefault<z.ZodArray<z.ZodObject<{
            use: z.ZodString;
            instead: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            use: string;
            instead?: string | undefined;
        }, {
            use: string;
            instead?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        voice: string;
        terms: {
            use: string;
            instead?: string | undefined;
        }[];
    }, {
        id: string;
        name: string;
        voice?: string | undefined;
        terms?: {
            use: string;
            instead?: string | undefined;
        }[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    id: string;
    status: "drafting" | "ready" | "published";
    sources: {
        id: string;
        freshness: "changed" | "unreachable" | "current" | "unchecked";
        kind: "code" | "document" | "web" | "say_so" | "upload";
        trust: "lower" | "normal";
        note?: string | undefined;
        address?: string | undefined;
        passage?: string | undefined;
        readAt?: string | undefined;
        fingerprint?: string | undefined;
        fetchedPassage?: string | undefined;
        lines?: {
            from: number;
            to: number;
        } | undefined;
    }[];
    suggestions: {
        id: string;
        reason: string;
        createdAt: string;
        span: {
            quote: string;
            start: number;
            end: number;
        };
        state: "rejected" | "pending" | "stale" | "accepted" | "edited_accepted";
        replacement: string;
        proposedBy: "assistant" | "writer";
        model?: string | undefined;
        ideaIds?: string[] | undefined;
        commentIds?: string[] | undefined;
        sectionIds?: string[] | undefined;
    }[];
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
    formatVersion: number;
    corrections: {
        id: string;
        kind: "say_so";
        note: string;
        articleId: string;
        capturedAt: string;
        trust: "lower";
        supersedes?: string | undefined;
    }[];
    title: string;
    sections: {
        id: string;
        review: {
            state: "clean" | "needs_review" | "being_revised" | "held";
            at?: string | undefined;
            reason?: string | undefined;
            setBy?: "writer" | "resolver" | "editor" | undefined;
        };
        span: {
            start: number;
            end: number;
        };
        heading: string;
        level: number;
        order: number;
        parentId?: string | undefined;
        purpose?: string | undefined;
    }[];
    claims: {
        id: string;
        kind: "factual" | "opinion" | "framing";
        author: "model" | "writer" | "mixed";
        quote: string;
        confirmed: boolean;
        sectionId: string;
        position: number;
        authorAt: string;
        sourceStatus: "none" | "supported" | "not_checked" | "contradicted" | "attached" | "partly_supported" | "not_supported" | "stale";
        lookup?: {
            at: string;
            outcome: "unavailable" | "no_results" | "none_supported";
            claimText: string;
            tried: string[];
        } | undefined;
        check?: {
            model: string;
            reason: string;
            ranAt: string;
            claimText: string;
            sourceFingerprints: Record<string, string>;
        } | undefined;
        needsRecheck?: boolean | undefined;
    }[];
    links: {
        at: string;
        id: string;
        from: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        to: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        kind: string;
        origin: "proposed" | "confirmed" | "drawn";
        confidence?: number | undefined;
        reason?: string | undefined;
    }[];
    ideas: {
        id: string;
        text: string;
        origin: "assistant" | "writer";
        createdAt: string;
        state: "used" | "dropped" | "open";
        model?: string | undefined;
        sectionId?: string | undefined;
        usedIn?: string | undefined;
    }[];
    name?: string | undefined;
    brief?: {
        length?: string | undefined;
        notes?: string | undefined;
        purpose?: string | undefined;
        audience?: string | undefined;
        tone?: string | undefined;
    } | undefined;
    style?: {
        id: string;
        name: string;
        voice: string;
        terms: {
            use: string;
            instead?: string | undefined;
        }[];
    } | undefined;
    scratchpad?: string | undefined;
}, {
    id: string;
    status: "drafting" | "ready" | "published";
    sources: {
        id: string;
        freshness: "changed" | "unreachable" | "current" | "unchecked";
        kind: "code" | "document" | "web" | "say_so" | "upload";
        trust: "lower" | "normal";
        note?: string | undefined;
        address?: string | undefined;
        passage?: string | undefined;
        readAt?: string | undefined;
        fingerprint?: string | undefined;
        fetchedPassage?: string | undefined;
        lines?: {
            from: number;
            to: number;
        } | undefined;
    }[];
    suggestions: {
        id: string;
        reason: string;
        createdAt: string;
        span: {
            quote: string;
            start: number;
            end: number;
        };
        state: "rejected" | "pending" | "stale" | "accepted" | "edited_accepted";
        replacement: string;
        proposedBy: "assistant" | "writer";
        model?: string | undefined;
        ideaIds?: string[] | undefined;
        commentIds?: string[] | undefined;
        sectionIds?: string[] | undefined;
    }[];
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
    formatVersion: number;
    corrections: {
        id: string;
        kind: "say_so";
        note: string;
        articleId: string;
        capturedAt: string;
        trust: "lower";
        supersedes?: string | undefined;
    }[];
    title: string;
    sections: {
        id: string;
        review: {
            state: "clean" | "needs_review" | "being_revised" | "held";
            at?: string | undefined;
            reason?: string | undefined;
            setBy?: "writer" | "resolver" | "editor" | undefined;
        };
        span: {
            start: number;
            end: number;
        };
        heading: string;
        level: number;
        order: number;
        parentId?: string | undefined;
        purpose?: string | undefined;
    }[];
    claims: {
        id: string;
        kind: "factual" | "opinion" | "framing";
        author: "model" | "writer" | "mixed";
        quote: string;
        confirmed: boolean;
        sectionId: string;
        position: number;
        authorAt: string;
        sourceStatus: "none" | "supported" | "not_checked" | "contradicted" | "attached" | "partly_supported" | "not_supported" | "stale";
        lookup?: {
            at: string;
            outcome: "unavailable" | "no_results" | "none_supported";
            claimText: string;
            tried: string[];
        } | undefined;
        check?: {
            model: string;
            reason: string;
            ranAt: string;
            claimText: string;
            sourceFingerprints: Record<string, string>;
        } | undefined;
        needsRecheck?: boolean | undefined;
    }[];
    links: {
        at: string;
        id: string;
        from: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        to: {
            id: string;
            type: "source" | "section" | "claim" | "comment";
        };
        kind: string;
        origin: "proposed" | "confirmed" | "drawn";
        confidence?: number | undefined;
        reason?: string | undefined;
    }[];
    name?: string | undefined;
    brief?: {
        length?: string | undefined;
        notes?: string | undefined;
        purpose?: string | undefined;
        audience?: string | undefined;
        tone?: string | undefined;
    } | undefined;
    style?: {
        id: string;
        name: string;
        voice?: string | undefined;
        terms?: {
            use: string;
            instead?: string | undefined;
        }[] | undefined;
    } | undefined;
    ideas?: {
        id: string;
        text: string;
        origin: "assistant" | "writer";
        createdAt: string;
        state: "used" | "dropped" | "open";
        model?: string | undefined;
        sectionId?: string | undefined;
        usedIn?: string | undefined;
    }[] | undefined;
    scratchpad?: string | undefined;
}>;
export type ArticleMeta = z.infer<typeof ArticleMetaSchema>;
export declare function createArticleMeta(id: string, title: string): ArticleMeta;
export type LoadResult = {
    ok: true;
    meta: ArticleMeta;
} | {
    ok: false;
    reason: string;
};
/** Loads a metadata file's JSON. Refuses what it cannot read completely, with a message; never loads partially. */
export declare function parseArticleMeta(raw: unknown): LoadResult;
