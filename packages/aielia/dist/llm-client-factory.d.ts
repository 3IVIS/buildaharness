import { ILLMClient } from '@buildaharness/runtime';
import { AssistantConfig } from './config.js';
export interface LlmClientFactoryOptions {
    /** Passed to every HTTP client. The desktop app supplies Tauri's fetch, because its webview CSP blocks the global one. */
    fetchImpl?: typeof fetch;
    /**
     * Builds the surface's own claude-cli client (the CLI's file/shell/web/action tools, desktop's Tauri bridge).
     * Return undefined where `claude -p` cannot run (a plain browser tab) and the factory falls back to the proxy.
     */
    claudeCli: () => ILLMClient | undefined;
}
/** The one switch over the five backends. Only the claude-cli client and `fetch` differ per surface, and both come in through the options. */
export declare function createLlmClient(config: AssistantConfig, { fetchImpl, claudeCli }: LlmClientFactoryOptions): ILLMClient;
