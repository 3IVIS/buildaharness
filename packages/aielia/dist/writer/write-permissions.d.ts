import { z } from 'zod';
import { ChatMessage, ILLMClient, TokenUsage } from '@buildaharness/runtime';
/**
 * The permission list (T11): what the assistant may do on its own in Aielia Write, with defaults the writer can change, and
 * a spending cap that stops model calls once reached. Changes the text only ever as suggestions (T9), so there is no
 * "edit directly" permission to grant. Pure data plus a client wrapper; storage goes through any `get`/`set` of settings.
 */
export declare const WritePermissionsSchema: z.ZodObject<{
    /** Read each message for reviewer comments, decisions and corrections (T13). On by default; off means nothing is recorded from chat. */
    captureChat: z.ZodBoolean;
    /** Run the claim check and the effects check on its own after the writer stops typing. Off by default: it spends the writer's money without being asked. */
    autoCheck: z.ZodBoolean;
    /** Read the web sources again just before publishing, and say which changed or could not be reached. On by default: it costs a model call only for a page that changed. Publishing is never blocked by it. */
    recheckBeforePublish: z.ZodDefault<z.ZodBoolean>;
    /** Stop all model calls once this much has been spent in this browser, in US dollars. Unset means no cap. */
    spendCapUsd: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    captureChat: boolean;
    autoCheck: boolean;
    recheckBeforePublish: boolean;
    spendCapUsd?: number | undefined;
}, {
    captureChat: boolean;
    autoCheck: boolean;
    recheckBeforePublish?: boolean | undefined;
    spendCapUsd?: number | undefined;
}>;
export type WritePermissions = z.infer<typeof WritePermissionsSchema>;
export declare const DEFAULT_WRITE_PERMISSIONS: WritePermissions;
export interface SettingsStore {
    getSetting(key: string): Promise<unknown>;
    setSetting(key: string, value: unknown): Promise<void>;
}
export declare function loadPermissions(store: SettingsStore): Promise<WritePermissions>;
export declare function savePermissions(store: SettingsStore, permissions: WritePermissions): Promise<void>;
export declare class SpendCapReachedError extends Error {
    readonly capUsd: number;
    readonly spentUsd: number;
    constructor(capUsd: number, spentUsd: number);
}
/** Running total of what the model calls cost, persisted so a reload does not reset the cap. */
export interface SpendMeter {
    spentUsd(): number;
    /** `model` is the model that made the call; it is priced by that model, falling back to the meter's default. */
    record(usage: CountedUsage, callType?: string, model?: string): Promise<void>;
    /** Dollars and number of calls so far for each kind of call (the chat, the claim check, ...). Calls made before this was kept are in the total only. */
    byType(): Record<string, {
        usd: number;
        calls: number;
    }>;
    /** Throws SpendCapReachedError when the cap is set and reached. */
    assertWithinCap(capUsd: number | undefined): void;
    /** Back to nothing spent, after the stored totals were deleted. */
    reset(): void;
    /** Dollars, tokens and calls counted since the page was opened (the dollars include what earlier visits spent). A caller takes one before and one after a request to know what that request cost. */
    snapshot(): SpendSnapshot;
    /** Called after every counted call and after a reset, so what is shown follows the real total. Returns the way to stop listening. */
    subscribe(listener: () => void): () => void;
}
/** `cachedTokens` is the part of the input that came from the provider's cache; absent until some call has reported it (a backend that does not report it is not the same as none cached). */
/** `estimatedInputTokens` is the part of `inputTokens` that was worked out from the size of the requests because the backend reported far fewer than they held. */
export interface SpendSnapshot {
    usd: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    cachedTokens?: number;
    estimatedInputTokens?: number;
}
/** Token counts as the meter takes them: `estimated` marks an input count that was worked out from the request, not reported. */
export type CountedUsage = TokenUsage & {
    estimated?: boolean;
};
/** About four characters to a token: a rough size for a request, used only when the backend's own count cannot be believed. */
export declare function estimateInputTokens(messages: readonly ChatMessage[]): number;
/**
 * A backend (a proxy that drops them, say) can report a handful of input tokens for a request that holds thousands. Then the input is counted by the size
 * of the request, so the cost and the cap are not understated, and the count is marked as estimated. A count that is plausible is left as reported.
 */
export declare function withEstimatedInput(usage: TokenUsage, messages: readonly ChatMessage[]): CountedUsage;
export declare function createSpendMeter(store: SettingsStore, pricing: {
    backend?: string;
    model?: string;
}): Promise<SpendMeter>;
/**
 * Wraps a client so every call is counted, and no call starts once the cap is reached. Every model step in the article
 * service fails closed on an error (nothing is marked checked), so hitting the cap degrades to "not checked", never to a wrong result.
 */
export declare function withSpendCap(inner: ILLMClient, meter: SpendMeter, getCap: () => number | undefined): ILLMClient;
