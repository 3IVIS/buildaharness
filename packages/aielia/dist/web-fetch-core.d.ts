/**
 * Thrown by assertPublicHttpUrl instead of returning a falsy value, so callers
 * can't accidentally proceed past a rejected URL.
 */
export declare class PrivateNetworkTargetError extends Error {
    readonly requestedUrl: string;
    readonly detail: string;
    constructor(requestedUrl: string, detail: string);
}
/** Thrown when the fetched body's content-type (header and/or sniffed bytes) isn't on the allowlist. */
export declare class UnsupportedContentTypeError extends Error {
    readonly requestedUrl: string;
    readonly detail: string;
    constructor(requestedUrl: string, detail: string);
}
/** Resolves a hostname to its IP addresses. Injected so assertPublicHttpUrl stays unit-testable without real DNS/network access. */
export type DnsResolver = (hostname: string) => Promise<string[]>;
/**
 * Parses `url`, rejects non-http(s) schemes / credentialed URLs / non-80/443 ports / raw IP
 * literals outright (all before any DNS call), then resolves the hostname and throws
 * PrivateNetworkTargetError if any resolved address is loopback, RFC1918 private, link-local,
 * or a well-known cloud metadata address. Must be called again on every redirect hop — a public
 * URL can 302 to a private one — which is exactly what fetchTextSafely's redirect loop below does.
 */
export declare function assertPublicHttpUrl(url: string, dns?: DnsResolver): Promise<void>;
export declare const MAX_REDIRECTS = 5;
export declare const MAX_FETCH_CHARS = 15000;
export interface FetchTextSafelyOptions {
    url: string;
    dns?: DnsResolver;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    maxRedirects?: number;
    allowedContentTypes?: string[];
    timeoutMs?: number;
}
export interface FetchTextSafelyResult {
    text: string;
    finalUrl: string;
    /** True if either the streamed byte cap or the char-level cap truncated the returned text. */
    truncated: boolean;
}
/**
 * Fetches `options.url`, following redirects manually (not via fetch's automatic redirect-follow)
 * so every hop gets its own assertPublicHttpUrl check — a public URL that 302s to a private
 * target is rejected mid-fetch, not silently followed. Enforces a streamed byte cap (a
 * Content-Length header can lie), a content-type allowlist (checked against both the header and
 * the sniffed body bytes), and a connect+read timeout. Sends a fixed User-Agent and nothing else
 * client-supplied — zero ambient authority, safe to run on a caller's behalf server-side.
 */
export declare function fetchTextSafely(options: FetchTextSafelyOptions): Promise<FetchTextSafelyResult>;
