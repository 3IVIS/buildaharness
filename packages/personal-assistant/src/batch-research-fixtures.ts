import type { LLMStructuredResponse } from '@buildaharness/runtime'
import type { WebSearchResult } from './web-tools.js'

/**
 * The real school-dates comparison this plan is built on (see
 * plans/personal_assistant_dynamic_tool_budget_plan.html's Reference Transcripts tab), encoded as
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
  item: string
  searchYields: ReadonlyArray<'productive' | 'dead_end'>
  /** The model's own final per-item answer, once every scripted search yield above has been
   * consumed. Omitted only for an item whose sub-loop resolves via the dead-end window instead
   * (see the doc comment above). */
  finalAnswer?: string
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
export const SCHOOL_DATES_BATCH_FIXTURE: readonly BatchFixtureItem[] = [
  {
    item: 'Grunewald-Grundschule',
    searchYields: [],
    finalAnswer: 'Not found — their open-house calendar is embedded in an external tool (Schulmanager Online) that cannot be accessed directly.',
  },
  {
    item: 'Erich-Kästner-Grundschule',
    searchYields: ['productive', 'productive', 'productive', 'productive'],
    finalAnswer: 'Confirmed: Tuesday, June 17, 2025, 15:00-18:00 — found in the school\'s own Terminplan PDF.',
  },
  {
    item: 'Lietzensee-Grundschule',
    searchYields: ['productive'],
    finalAnswer: 'October 6, 2025, from 9:00 — stated on the school website.',
  },
  {
    item: 'Halensee-Grundschule',
    searchYields: ['dead_end', 'dead_end', 'dead_end'],
    // No finalAnswer: the dead-end window trips before any final LLM call for this item —
    // resolveBatchItem synthesizes its own "not found" content instead.
  },
  {
    item: 'Carl-Orff-Grundschule',
    searchYields: ['productive'],
    finalAnswer: 'Thursday, October 2, 2025, 10:00-12:00 — explicitly stated on their website.',
  },
  {
    item: 'Stechlinsee-Grundschule',
    searchYields: ['productive'],
    finalAnswer: 'September 16, 2025, 9:00-13:00 — per the school homepage.',
  },
  {
    item: 'Grundschule am Rüdesheimer Platz',
    searchYields: ['productive'],
    finalAnswer: 'Thursday, September 26, 2024 — most recent confirmed date found.',
  },
]

/** The batch request message a user would actually send — each item on its own line, matching
 * detectHomogeneousBatchList's expected shape. */
export function fixtureUserMessage(items: readonly BatchFixtureItem[] = SCHOOL_DATES_BATCH_FIXTURE): string {
  return items.map((i) => i.item).join('\n')
}

/** True once an item's last 3 search yields are all 'dead_end' — the same condition
 * resolveBatchItem's trackYield closure checks (BATCH_DEAD_END_WINDOW = 3). */
function tripsDeadEndWindow(item: BatchFixtureItem): boolean {
  return item.searchYields.length >= 3 && item.searchYields.slice(-3).every((y) => y === 'dead_end')
}

/**
 * The ordered callChatStructured script every item's own sub-loop consumes, in the exact order
 * runBatchToolLoop/resolveRemainingBatchItems resolve them (probe items first, in array order,
 * then the rest in array order) — a ScriptedToolLLMClient (see assistant.test.ts) plays this back
 * verbatim regardless of what the mocked web_search calls actually return.
 */
export function fixtureStructuredResponses(items: readonly BatchFixtureItem[] = SCHOOL_DATES_BATCH_FIXTURE): LLMStructuredResponse[] {
  let callId = 0
  const responses: LLMStructuredResponse[] = []
  for (const fixtureItem of items) {
    for (const _yield of fixtureItem.searchYields) {
      responses.push({ content: '', toolCalls: [{ id: `fixture-${callId++}`, name: 'web_search', input: { query: fixtureItem.item } }] })
    }
    if (!tripsDeadEndWindow(fixtureItem)) {
      if (fixtureItem.finalAnswer === undefined) {
        throw new Error(`Fixture item "${fixtureItem.item}" needs a finalAnswer — its search yields don't trip the dead-end window`)
      }
      responses.push({ content: fixtureItem.finalAnswer })
    }
  }
  return responses
}

/**
 * A stateful web_search mock consuming `searchYields` in the same flattened order
 * fixtureStructuredResponses schedules its tool calls in — 'dead_end' yields an empty result
 * array (web-tools.ts's executor turns that into the literal "No results found."); 'productive'
 * yields one real-looking result.
 */
export function fixtureWebSearch(items: readonly BatchFixtureItem[] = SCHOOL_DATES_BATCH_FIXTURE): () => Promise<WebSearchResult[]> {
  const yields = items.flatMap((i) => i.searchYields)
  let i = 0
  return async () => {
    const y = yields[i++]
    if (y === 'dead_end') return []
    return [{ title: 'School website', url: 'https://example.com', snippet: 'The open house date is confirmed on the school calendar.' }]
  }
}
