import { createScriptedLLMClient } from '@buildaharness/personal-assistant'
import type { ScriptedLLMClientScript } from '@buildaharness/personal-assistant'
import { createInMemoryFsBackend } from './in-memory-fs-backend'

/**
 * The browser-side half of the B2 Playwright harness (plans/chat_ui_browser_e2e_plan.html).
 *
 * A Playwright `addInitScript` runs in the page *before* the app bundle and cannot `import`
 * anything, so it can't build the {@link import('../assistant-test-hooks').AssistantTestHooks}
 * object directly — those need `createScriptedLLMClient` / `createInMemoryFsBackend`, which live
 * in the bundle. This module bridges the gap: it is imported by `main.tsx` **only** when
 * `import.meta.env.VITE_E2E === '1'` (a constant folded to `false` in any production build, so the
 * whole dynamic import is tree-shaken away), and it publishes those two factories on
 * `window.__BAH_E2E_FACTORY__`. The init script then does:
 *
 * ```js
 * window.__BAH_E2E__ = {
 *   makeLlmClient: () => window.__BAH_E2E_FACTORY__.createScriptedLLMClient(script),
 *   makeFsBackend: () => window.__BAH_E2E_FACTORY__.createInMemoryFsBackend(fsSeed),
 * }
 * ```
 *
 * `getAssistantTestHooks()` reads `window.__BAH_E2E__`; the factory calls resolve later, once the
 * app is building its assistant, by which point this module has run.
 */
export interface E2EFactory {
  createScriptedLLMClient: (script: ScriptedLLMClientScript) => ReturnType<typeof createScriptedLLMClient>
  createInMemoryFsBackend: (seed?: Record<string, string>) => ReturnType<typeof createInMemoryFsBackend>
}

declare global {
  interface Window {
    __BAH_E2E_FACTORY__?: E2EFactory
  }
}

export function installE2EFactory(): void {
  window.__BAH_E2E_FACTORY__ = { createScriptedLLMClient, createInMemoryFsBackend }
}

installE2EFactory()
