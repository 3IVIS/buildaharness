import type { AssistantConfig } from '@buildaharness/personal-assistant'
import type { ILLMClient, FsBackend } from '@buildaharness/runtime'

/**
 * The one narrow, test-only seam for substituting what `buildAssistant()` /
 * `createTauriBackedAssistant()` construct — an injected {@link ILLMClient} (so an E2E turn is
 * byte-deterministic with no proxy / key / network) and, optionally, an in-memory
 * {@link FsBackend} (so `fileTools` is configured and the tool loop actually runs).
 *
 * Built for plans/chat_ui_browser_e2e_plan.html phase B1. Flag-OFF and no-hook behaviour is
 * byte-identical to today: {@link getAssistantTestHooks} returns `null` unless E2E mode is on.
 *
 * Two ways to install a hook, both gated on E2E mode:
 *   - {@link setAssistantTestHooks} — from a jsdom/unit test in the same module graph.
 *   - `window.__BAH_E2E__` — a Playwright `addInitScript` stashes a hooks object there before
 *     the app bundle runs; {@link getAssistantTestHooks} reads it when no in-process hook is set.
 *     This is what lets a *single* preview build cover both `oneLoopMode` states (the flag becomes
 *     a runtime value from the injected client's config, not a build constant).
 */
export interface AssistantTestHooks {
  makeLlmClient?: (config: AssistantConfig) => ILLMClient
  makeFsBackend?: () => FsBackend
}

const WINDOW_KEY = '__BAH_E2E__'

/**
 * True only in a test/E2E build — `MODE === 'test'` under Vitest, or an explicit `VITE_E2E=1` for
 * a Playwright preview build. A production bundle can never satisfy either, so the seam is
 * unreachable there. Read lazily (not a module const) so a unit test can flip it via
 * `vi.stubEnv('MODE', 'production')`.
 */
export function assistantTestHooksEnabled(): boolean {
  return import.meta.env.MODE === 'test' || import.meta.env.VITE_E2E === '1'
}

let inProcessHooks: AssistantTestHooks | null = null

/** Installs (or, with `null`, clears) the in-process hooks. No-ops with a warning outside E2E mode. */
export function setAssistantTestHooks(hooks: AssistantTestHooks | null): void {
  if (!assistantTestHooksEnabled()) {
    console.warn('[chat-ui] setAssistantTestHooks() ignored — not a test/E2E build.')
    return
  }
  inProcessHooks = hooks
}

/** The active hooks, or `null`. Prefers an in-process hook; falls back to `window.__BAH_E2E__`. */
export function getAssistantTestHooks(): AssistantTestHooks | null {
  if (!assistantTestHooksEnabled()) return null
  if (inProcessHooks) return inProcessHooks
  if (typeof window !== 'undefined') {
    const fromWindow = (window as unknown as Record<string, unknown>)[WINDOW_KEY]
    if (fromWindow && typeof fromWindow === 'object') return fromWindow as AssistantTestHooks
  }
  return null
}
