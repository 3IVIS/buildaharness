export type ToolYield = 'productive' | 'dead_end';
/**
 * Zero-LLM-call heuristic run on every web tool result inside a batch sub-loop, so it has to stay
 * cheap. Defaults to 'productive' whenever the result isn't unambiguously a dead end — see
 * DEAD_END_MARKERS' comment for why that asymmetry is deliberate.
 */
export declare function classifyToolYield(toolName: 'web_search' | 'fetch_url', resultText: string): ToolYield;
