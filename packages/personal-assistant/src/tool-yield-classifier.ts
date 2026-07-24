import { getDeadEndMarkers, testAny } from './lexical/patterns.js'

export type ToolYield = 'productive' | 'dead_end'

// The literal string web-tools.ts's own executor returns for a zero-result search
// (see web-tools.ts's executeWebTool, web_search branch) — an unambiguous automatic dead_end,
// not a heuristic guess.
const NO_RESULTS_LITERAL = 'No results found.'

// Drawn straight from real dead-end phrasing observed in the school-dates comparison transcripts
// (see the plan's Reference Transcripts tab) — a narrow, reviewed set, not a broad guess. Anything
// not matched here defaults to 'productive': a false negative (calling a genuine dead end
// "productive") only costs one extra call, while a false positive (calling real content a dead
// end) would prematurely abandon a findable item — the same asymmetry decomposition-classifier.ts
// accepts elsewhere.
// Compiled from packages/personal-assistant/src/lexical/patterns/tool-yield-markers.json (see
// lexical/patterns.ts).
const DEAD_END_MARKERS = getDeadEndMarkers()

/**
 * Zero-LLM-call heuristic run on every web tool result inside a batch sub-loop, so it has to stay
 * cheap. Defaults to 'productive' whenever the result isn't unambiguously a dead end — see
 * DEAD_END_MARKERS' comment for why that asymmetry is deliberate.
 */
export function classifyToolYield(toolName: 'web_search' | 'fetch_url', resultText: string): ToolYield {
  // .includes(), not exact equality: callers in the real pipeline (see assistant.ts's
  // resolveBatchItem) classify the result *after* executeToolCall has run it through
  // wrapUntrusted (and, rarely, an injection-warning prefix) — the literal marker is a substring
  // of that wrapped text, never the whole of it.
  if (toolName === 'web_search' && resultText.includes(NO_RESULTS_LITERAL)) return 'dead_end'
  if (testAny(DEAD_END_MARKERS, resultText)) return 'dead_end'
  return 'productive'
}
