import { AssistantConfig, ConfigStore } from './config.js';
import { KeyTestResult, KeyedBackend } from './provider-setup.js';
export interface FirstRunDeps {
    configStore: ConfigStore;
    /** Result of `configStore.load()` — the setup is skipped entirely if this already names a backend/key. */
    persisted: Partial<AssistantConfig>;
    /** Keys pinned by an env var (ASSISTANT_LLM_BACKEND etc.) — also a signal the user has already chosen. */
    overriddenKeys: ReadonlySet<keyof AssistantConfig>;
    /** False for piped/scripted stdin — setup is skipped and today's behavior (proxy default) is kept. */
    isInteractive: boolean;
    /** Reads one line from the user, already trimmed. */
    ask: (question: string) => Promise<string>;
    /** Where to print prompts/status (defaults to process.stdout in cli.ts). */
    log: (line: string) => void;
    /** Live-checks a key against the provider. Optional so unit tests can skip the network; cli.ts passes the real testApiKey. */
    testKey?: (backend: KeyedBackend, key: string) => Promise<KeyTestResult>;
}
/**
 * Runs the first-run pass if needed. Returns the persisted config to use from
 * here on — unchanged when setup was skipped or the user bailed out, or a fresh
 * object reflecting what was just written.
 */
export declare function maybeRunFirstRunSetup(deps: FirstRunDeps): Promise<Partial<AssistantConfig>>;
