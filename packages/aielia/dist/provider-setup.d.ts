import { AssistantConfig } from './config.js';
export type KeyedBackend = Extract<AssistantConfig['llmBackend'], 'anthropic' | 'openai' | 'openrouter'>;
export interface ProviderSetupInfo {
    backend: KeyedBackend;
    /** Plain-language name shown to the user. */
    name: string;
    /** One line on who this is for / what it costs, for someone who has never done this before. */
    blurb: string;
    /** Where the user creates a key. */
    keyUrl: string;
    /** Human-readable form of `keyUrl` for terminals. */
    keyUrlLabel: string;
    /** Numbered walkthrough for someone with no account yet — shown before the key prompt. Plain text, no markup. */
    steps: readonly string[];
    /** Optional "protect your wallet" walkthrough, shown alongside `steps`. */
    safety?: {
        title: string;
        url: string;
        urlLabel: string;
        steps: readonly string[];
    };
    /** What a valid key starts with — used for a fast, offline sanity check and as the input placeholder. */
    keyPrefix: string;
}
export declare const PROVIDER_SETUP: readonly ProviderSetupInfo[];
export declare function getProviderSetup(backend: KeyedBackend): ProviderSetupInfo;
/** Pasted keys often carry stray whitespace, newlines, or wrapping quotes — strip them before anything else looks at the value. */
export declare function cleanApiKey(raw: string): string;
/**
 * Offline check for the mistakes a first-timer actually makes: pasting nothing, pasting a key
 * for a different provider, or pasting a sentence. Returns null when the key looks plausible
 * (which is not the same as valid — see testApiKey), otherwise a message to show the user.
 */
export declare function checkApiKeyFormat(backend: KeyedBackend, key: string): string | null;
export type KeyTestResult = {
    status: 'valid';
} | {
    status: 'invalid';
    message: string;
}
/** Couldn't reach the provider (offline, blocked, CORS…) — the key may still be fine, so callers let the user continue. */
 | {
    status: 'unverified';
    message: string;
};
/**
 * Asks the provider a free, read-only question ("list models" / "who am I") to find out
 * whether the key is accepted, so a typo surfaces during setup instead of as an opaque error
 * on the user's first message. Never throws.
 */
export declare function testApiKey(backend: KeyedBackend, key: string, fetchImpl?: typeof fetch): Promise<KeyTestResult>;
