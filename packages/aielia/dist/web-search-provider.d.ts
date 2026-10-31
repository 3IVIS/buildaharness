import { WebSearchResult } from './web-tools.js';
export interface BraveSearchOptions {
    maxResults?: number;
    fetchImpl?: typeof fetch;
}
/**
 * Queries the Brave Search API and returns a bounded, parsed result list. Matches
 * WebToolsContext['search']'s signature. Requires a Brave Search API key — see
 * https://api.search.brave.com/app/keys — passed as `apiKey`, sent as the
 * `X-Subscription-Token` header Brave's API expects.
 */
export declare function braveSearch(query: string, apiKey: string, options?: BraveSearchOptions): Promise<WebSearchResult[]>;
