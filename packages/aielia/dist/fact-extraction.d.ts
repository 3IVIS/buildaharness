import { FactConfidence, FactCategory } from './turn-intent-classifier.js';
/**
 * Provenance of a captured fact — Phase 5 of the harness/personal-assistant remediation plan
 * (the internal plan), replacing the previous bare
 * `durable: boolean` with a typed source plus a promotion policy keyed off it (see
 * assistant.ts's recordFacts()). USER_ASSERTED is this file's own free lexical marker pass
 * (extractFactsFromTurn) — unchanged in behavior and still auto-promotable, exactly as before
 * this phase. MODEL_INFERRED is classifyTurnIntent's statesDurableFact free-form LLM read, only
 * ever consulted when the lexical pass found nothing — no longer auto-promoted to durable status
 * on its own (see recordFacts). OBSERVED and EXTERNALLY_VERIFIED have no producer in this
 * codebase yet (e.g. a future tool-observed state claim, or Phase 6's AnswerClaim evidence
 * trail) — defined now so a future producer has a typed slot to land in rather than overloading
 * MODEL_INFERRED for something with a different trust profile.
 *
 * Storage-taxonomy note (Phase 5b, superseded by Phase E's typed `MemoryTier` below): `UserFact`
 * is this codebase's Knowledge-shaped data ("what we believe") — `text`/`durable` is the belief
 * itself; `FactSource` is its provenance ("why we believe it"). See
 * packages/aielia/README.md's "Memory tiers" section for the full tier map this fits
 * into, and memory-service.ts's DURABLE_FACTS_KEY doc comment for where promoted facts are stored.
 */
export type FactSource = 'user_asserted' | 'model_inferred' | 'observed' | 'externally_verified';
export interface UserFact {
    text: string;
    extractedAt: string;
    sourceTurn: string;
    /**
     * True for a fact currently promoted to the cross-session store that survives /new (name,
     * stated preference, health/dietary — see DURABLE_MARKERS below), false for a session-scoped
     * detail (current location, current job, "remember that"-style context, or an unconfirmed
     * MODEL_INFERRED claim) that's expected to change more often or hasn't earned promotion yet.
     * Derived from `source` via the promotion policy in recordFacts(), not set independently.
     * assistant.ts's recordFacts() stores promoted facts in a second, never-cleared store in
     * addition to the per-session one.
     */
    durable: boolean;
    /** See FactSource. */
    source: FactSource;
    /**
     * Confidence `classifyTurnIntent`'s `StatedFact.confidence` (turn-intent-classifier.ts) assigns
     * a `model_inferred` fact — undefined for `user_asserted`/`observed`/`externally_verified`
     * facts, which have no confidence gradient (they either matched a lexical pattern or didn't).
     * Added in Phase 2 of the internal plan for
     * `recordFacts()`'s three-way promotion policy; Phase 4 additionally uses it to adjust
     * `tierForFact()` and to annotate the per-turn facts prompt block. `migrateFact()` needs no
     * change for this field — a pre-existing on-disk fact with no `confidence` reads back as
     * `undefined`, which every reader here already treats as "no confidence signal, most
     * conservative".
     */
    confidence?: FactConfidence;
    /**
     * `StatedFact.category` (turn-intent-classifier.ts) carried through onto the stored fact —
     * undefined for `user_asserted`/`observed`/`externally_verified` facts, same "no signal from
     * that source" convention `confidence` already follows. Added in Phase 3 of
     * the internal plan so a medium-confidence
     * fact queued to `facts:pending-confirmation` (memory-service.ts) carries the topic its
     * `/memory` grouping needs — see that file's `PendingFact`.
     */
    category?: FactCategory;
    /**
     * The project label this fact is scoped to — undefined means global (always shown, regardless
     * of which project is active). Set by `MemoryService.recordFacts()`/`buildTurnFacts()` only for
     * a fact classified `category: 'project'` (see FactCategory), using whatever
     * `PersonalAssistant`'s `currentProject()` getter resolves to at capture time: an explicit
     * `config.activeProject` override if the user set one via `/project <name>`, else the workspace
     * root the assistant is running in. A fact in any other category is inherently about the user,
     * not a codebase, so it stays global on purpose even while a project is active.
     * `loadFacts()`/`getMemorySummary()` still return every fact regardless of `project` — only the
     * turn's `factsBlock` (what the model actually sees) filters to global-or-current-project, so
     * `/memory` stays a complete inventory the user can review/forget from regardless of which
     * project is currently active.
     */
    project?: string;
    /**
     * M1 (agent memory framework): a model-chosen stable key for a fact naming a single-valued
     * attribute ("home_city", "preferred_editor"). A new fact with the same key replaces the old
     * one (see `MemoryService.recordFacts()`). Never derived from wording in code; undefined for
     * a fact that names no single-valued attribute, which keeps today's accumulate behaviour.
     */
    key?: string;
    /** M1: set on the replacing fact — the text of the entry it retired. */
    supersedes?: string;
    /** M1: set on an entry moved to `facts:retired` when a keyed fact replaced it. */
    retiredAt?: string;
    /** M1 usage fields, updated lazily (batched, flushed from `recordFacts()`) when the fact is rendered into a prompt. */
    injectedCount?: number;
    lastInjectedAt?: string;
    /** M2: where the claim came from. Undefined = `user`. A non-`user` origin can only ever be episodic (see `tierForFact`). */
    origin?: FactOrigin;
    /** M2: the user's own supporting words for a `model_inferred` claim, returned by the classifier. Stored for audit/`/memory` display, never string-matched. */
    evidence?: string;
    /** M2: set on a pending entry the write gate's semantic injection judgement flagged as instruction-shaped; never auto-promoted. */
    flagged?: boolean;
    /** M2: transient classifier judgement carried from `buildTurnFacts` to the write gate; stripped before anything is persisted. */
    judgement?: CandidateJudgement;
}
/** M2: structured provenance next to `FactSource`; only `user` may reach a Knowledge tier. */
export type FactOrigin = 'user' | 'agent' | 'tool' | 'web';
/** M2: the classifier's per-fact judgement. Either field undefined means the judgement is missing (the gate fails closed). */
export interface CandidateJudgement {
    containsSecret?: boolean;
    /** Fact text with the secret removed; empty/undefined when the whole claim is the secret. */
    redactedText?: string;
    looksLikeInstruction?: boolean;
}
/** Every fact has a certainty for `/memory` display purposes, even one with no `confidence` gradient (user_asserted/observed/externally_verified) — those are exactly as certain as a stated fact gets, so they display as 'high' rather than blank. Never used for promotion/tier logic, which still reads `fact.confidence` directly and treats undefined as "no LLM confidence signal" (see that field's own doc comment) — this is purely a rendering convenience. */
export declare function certaintyLabel(fact: UserFact): FactConfidence;
/** What to say next to a remembered fact that is not stored: held for confirmation in Pending, or kept for this conversation only. A stored (durable) fact needs no note, so this returns undefined. One rule for the CLI's /memory and the apps' Memory panel, so "Facts I know" never reads as stored when the assistant has said it was not. */
export declare function factStatusLabel(fact: Pick<UserFact, 'text' | 'durable'>, pending?: readonly {
    text: string;
}[]): string | undefined;
export declare function migrateFact(fact: UserFact): UserFact;
/**
 * The six-tier taxonomy (Phase E of the harness consolidation plan, criticism001 #8 /
 * criticism002 #6: "transcript ≠ memory"), made real as a type instead of the doc-comment-only
 * split this file's `FactSource` note above already described. `UserFact` only ever populates
 * four of these — `procedural` (the `ExperienceStore`) and `commitment` (`ReminderStore`) are
 * separate stores with their own writers and never routed through `tierForFact`; keeping them in
 * this union (rather than a narrower `UserFactTier`) is what lets `TIER_RULES.procedural`'s empty
 * `allowedSources` structurally enforce INV-16 (no Experience entry is ever reachable as a
 * `UserFact`, let alone a Knowledge one) instead of relying on every caller to remember to check.
 */
export type MemoryTier = 'episodic' | 'semantic' | 'procedural' | 'preference' | 'commitment' | 'identity';
export interface TierRule {
    /** FactSource values allowed to populate this tier — see TIER_RULES. */
    allowedSources: FactSource[];
    /** 'session': cleared with the rest of `facts:${sessionId}` on /new. 'durable': survives /new (DURABLE_FACTS_KEY today). */
    retention: 'session' | 'durable';
    /** Whether contradiction detection considers entries in this tier (see harness-bridge.ts's factExtractor). */
    contradictionChecked: boolean;
}
/**
 * Retention / contradiction / (implicitly, via `retention`) deletion rule per tier, plus the
 * `FactSource` provenances allowed to populate it — the four properties Phase E's scope calls
 * for. `procedural` and `commitment` have an empty `allowedSources`: no `UserFact` is ever tagged
 * with either tier (see `tierForFact` below), so a `UserFact` can never populate the Experience or
 * Commitment stores through this path — that's the structural half of INV-16, not just a runtime
 * check.
 */
export declare const TIER_RULES: Record<MemoryTier, TierRule>;
/**
 * Routes a `UserFact` to its `MemoryTier` per Phase E / E3's rule, extended by Phase 4 of
 * the internal plan: `observed` (a future
 * tool-observed claim) always stays `episodic` — an uncorroborated observation, never Knowledge.
 * `model_inferred` (the LLM's `statesDurableFacts` guess) stays `episodic` too UNLESS it's both
 * `durable` and `confidence === 'high'` — Phase 1's own definition of high confidence ("the user
 * states it directly and unhedged about themselves in first person") is the same trust bar
 * `user_asserted` facts clear by construction, so a high-confidence durable guess is routed
 * exactly the same way from here on; medium/low confidence (or no confidence signal at all) stays
 * a musing until/unless it's promoted via `/memory confirm` or corroboration reaches high — see
 * `memory-service.ts`'s `promoteConfirmedFact()`, which re-sources a confirmed fact to
 * `externally_verified` rather than relying on this function's `durable` check, since a fact
 * queued via the low-confidence corroboration path isn't guaranteed to carry `durable: true`.
 * `user_asserted`/`externally_verified`/qualifying `model_inferred` facts land in the durable
 * `identity` or `preference` tier when the text itself reads as a name/preference statement and
 * the fact earned promotion (`durable: true`); every other such fact (a stated job, location, or
 * coding-fact-shaped claim — see `looksLikeCodingFact` — none of which are `durable` under
 * `isDurable()` above) is `semantic`: still a stated claim about what's currently true, still
 * eligible for contradiction detection (the "tests passed"/"tests failed" and nurse-vs-designer
 * job-flip cases this file's admission logic exists to support), just not promoted to
 * cross-session storage. Pure and total — every `UserFact` maps to exactly one tier, and
 * `procedural`/`commitment` are never returned (see `TIER_RULES`'s doc comment).
 */
export declare function tierForFact(fact: UserFact): MemoryTier;
/**
 * The reliability the harness's world model should give this fact's belief — 'HIGH' (confidence
 * 1.0, the >= 0.8 bar the change reviewer and contradiction severity read) for a fact the user
 * stated directly or that has been externally verified, and for a `model_inferred` one that
 * cleared the same durable + high-confidence bar `tierForFact` uses to treat it as Knowledge;
 * everything else stays 'MEDIUM' (0.5), so an unconfirmed guess never reads as an established fact.
 */
export declare function factReliability(fact: UserFact): 'HIGH' | 'MEDIUM';
/** Whether `tier` counts as the Knowledge tier for contradiction-detection purposes — see harness-bridge.ts's factExtractor and TIER_RULES.*.contradictionChecked. */
export declare function isKnowledgeTier(tier: MemoryTier): boolean;
/**
 * Extracts at most one durable fact from a user message — verbatim, not summarized. Returns []
 * when the message doesn't look like a fact statement.
 *
 * Also admits anything looksLikeCodingFact (contradiction-checker.ts) recognizes, unless the
 * message also reads as a request or a question rather than a claim — a build/test/service-state
 * claim like "the tests passed" is exactly what the World Model's belief/contradiction machinery
 * (CODING_FACT_MARKERS, NEGATION_PAIRS) is built to track, but FACT_MARKERS' personal-fact
 * phrasing never matched statements like that, so no belief was ever created for the
 * contradiction checks to compare — a "tests passed" / "tests failed" flip produced zero beliefs
 * and thus zero contradiction detection at any layer, lexical or LLM.
 */
export declare function extractFactsFromTurn(userMessage: string, sourceTurn: string): UserFact[];
