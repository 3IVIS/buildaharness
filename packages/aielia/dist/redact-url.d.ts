/** A URL with any user:password, and every query-string value, masked, so a credential embedded in proxyUrl is never printed. Text that is not a URL is returned unchanged. */
export declare function redactUrlCredentials(text: string): string;
