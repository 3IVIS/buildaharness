import { ToolDefinition } from '@buildaharness/runtime';
import { DnsResolver } from './web-fetch-core.js';
export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}
export { PrivateNetworkTargetError, assertPublicHttpUrl } from './web-fetch-core.js';
export type { DnsResolver } from './web-fetch-core.js';
export interface WebToolsContext {
    /** No default implementation — the caller supplies a real search backend (an API client, etc.), same way FileToolsContext's `backend` is injected rather than defaulted to real disk. See `braveSearch` in web-search-provider.ts for a ready-made one. */
    search(query: string): Promise<WebSearchResult[]>;
    /** Overrides the HTTP client fetch_url uses — defaults to the global `fetch`. Lets tests and non-browser runtimes inject their own. */
    fetchImpl?: typeof fetch;
    /** Injected DNS resolver for the SSRF guard below — defaults to a lazily-imported node:dns/promises. Tests inject a fake to avoid real network access. */
    dns?: DnsResolver;
}
export declare const WEB_SEARCH_TOOL: ToolDefinition;
export declare const FETCH_URL_TOOL: ToolDefinition;
export declare const WEB_TOOLS: ToolDefinition[];
export type WebToolResult = {
    kind: 'text';
    text: string;
};
/** Executes web_search/fetch_url. Both return raw, untagged text — trust-tagging is applied by the caller (assistant.ts), not here, so this stays a plain I/O layer like executeFileTool. */
export declare function executeWebTool(ctx: WebToolsContext, toolName: string, input: Record<string, unknown>): Promise<WebToolResult>;
