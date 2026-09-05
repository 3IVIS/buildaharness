import { test as base, expect, type Page, type Locator } from '@playwright/test'
import type { ScriptedLLMClientScript } from '@buildaharness/personal-assistant'

/**
 * Page objects + the `chat` fixture for the browser-e2e lane
 * (plans/chat_ui_browser_e2e_plan.html phase B2).
 *
 * A test calls `await chat({ script, oneLoopMode?, fsSeed? })` to boot the app with:
 *   - a deterministic scripted `ILLMClient` wired through the B1 seam (no proxy / key / network),
 *   - an in-memory `FsBackend` so the tool loop actually runs,
 *   - `oneLoopMode` persisted into `buildaharness.personal-assistant.config` so a *single*
 *     preview build covers both flag states (B1 made the flag a runtime value).
 *
 * All of this is installed by one `addInitScript` that runs before the app bundle. It can't
 * `import`, so it reaches the scripted-client / in-memory-FS constructors through
 * `window.__BAH_E2E_FACTORY__`, which the E2E build publishes (see src/e2e/e2e-runtime.ts).
 */

/** localStorage key the browser config store reads — see src/browser-config-store.ts. */
const CONFIG_STORAGE_KEY = 'buildaharness.personal-assistant.config'

/** The scripted-LLM script, minus `classify` (a function — not structured-clonable across `addInitScript`). */
export type E2EScript = Omit<ScriptedLLMClientScript, 'classify'>

export interface ChatBootstrap {
  /** The scripted LLM conversation for this test. */
  script: E2EScript
  /** Persisted one-loop flag state. Omit → the app default (currently `disabled`). */
  oneLoopMode?: 'enabled' | 'disabled'
  /** Files the in-memory FsBackend is pre-populated with (keys are absolute, under `/workspace`). */
  fsSeed?: Record<string, string>
}

const INPUT_PLACEHOLDER = 'Message the assistant…'

export class ChatPage {
  constructor(readonly page: Page) {}

  private get input(): Locator {
    return this.page.getByPlaceholder(INPUT_PLACEHOLDER)
  }

  async waitReady(): Promise<void> {
    await this.input.waitFor({ state: 'visible' })
  }

  /**
   * Type `text`, hit Send, and wait for the turn to land. The assistant is constructed in an
   * async mount effect; a send before it resolves lands a retryable "still starting up" error —
   * click Retry if it shows, then wait for the turn's `proposer-kind` marker to appear.
   */
  async sendMessage(text: string): Promise<void> {
    await this.input.fill(text)
    await this.page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(async () => {
      const retry = this.page.getByRole('button', { name: 'Retry', exact: true })
      if (await retry.count()) await retry.first().click()
      await expect(this.proposerKindLocator).toBeAttached()
    }).toPass({ timeout: 15_000 })
  }

  private get proposerKindLocator(): Locator {
    return this.page.getByTestId('proposer-kind').last()
  }

  /** The rendered text of the most recent assistant message bubble. */
  lastAssistantBubble(): Locator {
    return this.page.locator('.bubble__content--markdown').last()
  }

  approvalCard(): Locator {
    return this.page.locator('.approval-card')
  }

  /** `'posthoc' | 'flat-oneloop' | 'batch-oneloop'` for the latest turn. */
  async proposerKind(): Promise<string> {
    return (await this.proposerKindLocator.textContent())?.trim() ?? ''
  }

  async approve(): Promise<void> {
    await this.approvalCard().getByRole('button', { name: 'Approve', exact: true }).click()
  }

  async deny(): Promise<void> {
    await this.approvalCard().getByRole('button', { name: 'Deny', exact: true }).click()
  }
}

export const test = base.extend<{ chat: (bootstrap: ChatBootstrap) => Promise<ChatPage> }>({
  chat: async ({ page }, use) => {
    await use(async ({ script, oneLoopMode, fsSeed }: ChatBootstrap) => {
      await page.addInitScript(
        (args: { key: string; config: Record<string, unknown>; script: E2EScript; fsSeed: Record<string, string> }) => {
          window.localStorage.setItem(args.key, JSON.stringify(args.config))
          const w = window as unknown as Record<string, any>
          w.__BAH_E2E__ = {
            makeLlmClient: () => w.__BAH_E2E_FACTORY__.createScriptedLLMClient(args.script),
            makeFsBackend: () => w.__BAH_E2E_FACTORY__.createInMemoryFsBackend(args.fsSeed),
          }
        },
        {
          key: CONFIG_STORAGE_KEY,
          config: { llmBackend: 'proxy', ...(oneLoopMode ? { oneLoopMode } : {}) },
          script,
          fsSeed: fsSeed ?? {},
        },
      )
      const chat = new ChatPage(page)
      await page.goto('/')
      await chat.waitReady()
      return chat
    })
  },
})

export { expect }
