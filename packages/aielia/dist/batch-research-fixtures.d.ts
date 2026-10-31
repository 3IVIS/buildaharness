import { LLMStructuredResponse } from '@buildaharness/runtime';
import { WebSearchResult } from './web-tools.js';
/**
 * The real school-dates comparison this plan is built on (see
 * the internal plan's Reference Transcripts tab), encoded as
 * a reusable scripted-LLM-response fixture instead of duplicated inline in assistant.test.ts —
 * so the integration replay test stays traceable back to the actual incident that motivated this
 * plan, and any recalibration of thresholds later has the real shape to check against.
 *
 * `searchYields` lists one entry per web_search call this item's own per-item sub-loop makes, in
 * order. An item whose last 3 entries are all `'dead_end'` (Halensee-Grundschule below) trips
 * resolveBatchItem's item-scoped dead-end window (BATCH_DEAD_END_WINDOW = 3) — that item never
 * reaches a final LLM call at all, so `finalAnswer` is omitted for it; every other item needs one.
 */
export interface BatchFixtureItem {
    /** Exact list-item text, as it will appear (one per line) in the batch request message. */
    item: string;
    searchYields: ReadonlyArray<'productive' | 'dead_end'>;
    /** The model's own final per-item answer, once every scripted search yield above has been
     * consumed. Omitted only for an item whose sub-loop resolves via the dead-end window instead
     * (see the doc comment above). */
    finalAnswer?: string;
}
/**
 * The actual 7-school request from the comparison transcript, in the same order the user pasted
 * them back. Grunewald-Grundschule (cheap — resolved without needing a single search) and
 * Erich-Kästner-Grundschule (expensive — needed several searches before the Terminplan PDF turned
 * up a confirmed date) are items[0]/items[1], so a 7-item batch's probe phase (probeCount = 2)
 * naturally covers both the cheap and the expensive case. Halensee-Grundschule (the genuinely
 * dead 404'd page) sits among the remaining items, proving the item-scoped dead-end window
 * doesn't drag down the other, perfectly findable schools queued behind it.
 */
export declare const SCHOOL_DATES_BATCH_FIXTURE: readonly BatchFixtureItem[];
/** The batch request message a user would actually send — each item on its own line, matching
 * detectHomogeneousBatchList's expected shape. */
export declare function fixtureUserMessage(items?: readonly BatchFixtureItem[]): string;
/**
 * The ordered callChatStructured script every item's own sub-loop consumes, in the exact order
 * runBatchToolLoop/resolveRemainingBatchItems resolve them (probe items first, in array order,
 * then the rest in array order) — a ScriptedToolLLMClient (see assistant.test.ts) plays this back
 * verbatim regardless of what the mocked web_search calls actually return.
 */
export declare function fixtureStructuredResponses(items?: readonly BatchFixtureItem[]): LLMStructuredResponse[];
/**
 * A stateful web_search mock consuming `searchYields` in the same flattened order
 * fixtureStructuredResponses schedules its tool calls in — 'dead_end' yields an empty result
 * array (web-tools.ts's executor turns that into the literal "No results found."); 'productive'
 * yields one real-looking result.
 */
export declare function fixtureWebSearch(items?: readonly BatchFixtureItem[]): () => Promise<WebSearchResult[]>;
