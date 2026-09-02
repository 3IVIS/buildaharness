/**
 * First-run setup for the CLI. `npx @buildaharness/personal-assistant` with no
 * env vars and no persisted config used to land on the default `proxy` backend
 * pointed at `http://localhost:8787` — a proxy almost nobody running it for the
 * first time has, so every turn failed with a connection error and no hint about
 * what to do. This runs one short interactive pass instead: reuse an existing
 * `claude` CLI login if there is one, otherwise ask for a provider + API key,
 * and persist the choice via the same ConfigStore `/config set` writes to.
 *
 * Split out of cli.ts (like non-interactive-mode.ts / error-classifier.ts) so it
 * can be unit-tested without a live REPL: every side-effecting dependency —
 * reading a line, detecting the `claude` binary — is injected.
 */

import type { AssistantConfig, ConfigStore } from './config.js'

export interface FirstRunDeps {
  configStore: ConfigStore
  /** Result of `configStore.load()` — the setup is skipped entirely if this already names a backend/key. */
  persisted: Partial<AssistantConfig>
  /** Keys pinned by an env var (ASSISTANT_LLM_BACKEND etc.) — also a signal the user has already chosen. */
  overriddenKeys: ReadonlySet<keyof AssistantConfig>
  /** False for piped/scripted stdin — setup is skipped and today's behavior (proxy default) is kept. */
  isInteractive: boolean
  /** Reads one line from the user, already trimmed. */
  ask: (question: string) => Promise<string>
  /** True when an authenticated `claude` CLI is available on PATH. */
  detectClaudeCli: () => Promise<boolean>
  /** Where to print prompts/status (defaults to process.stdout in cli.ts). */
  log: (line: string) => void
}

/** Any of these present means the user has already configured a backend — don't re-prompt. */
function alreadyConfigured(deps: FirstRunDeps): boolean {
  const { persisted, overriddenKeys } = deps
  if (persisted.llmBackend !== undefined) return true
  if (persisted.apiKey !== undefined || persisted.authToken !== undefined) return true
  for (const key of ['llmBackend', 'apiKey', 'authToken', 'proxyUrl'] as const) {
    if (overriddenKeys.has(key)) return true
  }
  return false
}

const PROVIDER_CHOICES: Record<string, { backend: AssistantConfig['llmBackend']; label: string }> = {
  '1': { backend: 'anthropic', label: 'Anthropic (Claude) — needs an sk-ant-… key' },
  '2': { backend: 'openai', label: 'OpenAI — needs an sk-… key' },
  '3': { backend: 'openrouter', label: 'OpenRouter — needs an sk-or-… key' },
}

/**
 * Runs the first-run pass if needed. Returns the persisted config to use from
 * here on — unchanged when setup was skipped or the user bailed out, or a fresh
 * object reflecting what was just written.
 */
export async function maybeRunFirstRunSetup(deps: FirstRunDeps): Promise<Partial<AssistantConfig>> {
  const { configStore, persisted, isInteractive, ask, detectClaudeCli, log } = deps

  if (alreadyConfigured(deps)) return persisted
  if (!isInteractive) return persisted

  log('')
  log("Welcome to Aielia — this looks like your first run. Let's pick how to reach a model.")
  log('(You can change any of this later with /config, or skip with Ctrl+C.)')
  log('')

  const patch: Partial<AssistantConfig> = {}

  if (await detectClaudeCli()) {
    const useClaude = await ask(
      'Found an authenticated `claude` CLI on your PATH. Use it? No API key needed. (Y/n) ',
    )
    if (useClaude === '' || useClaude.toLowerCase().startsWith('y')) {
      patch.llmBackend = 'claude-cli'
      await configStore.save(patch)
      log('')
      log('✓ Using the claude-cli backend. Try "what time zone is Tokyo in?", then')
      log('  "send an email to my boss saying I quit" to see the approval gate.')
      log('')
      return { ...persisted, ...patch }
    }
  }

  log('Pick a provider to use with your own API key:')
  for (const [key, { label }] of Object.entries(PROVIDER_CHOICES)) log(`  ${key}) ${label}`)
  const choice = (await ask('Provider [1-3, or Enter to skip]: ')).trim()
  const picked = PROVIDER_CHOICES[choice]
  if (!picked) {
    log('')
    log('Skipped. The assistant will start on the "proxy" backend (needs @buildaharness/proxy')
    log('on :8787). Run /config set llmBackend <anthropic|openai|openrouter> and')
    log('/config set apiKey <key> when you are ready, or set ASSISTANT_LLM_BACKEND + ASSISTANT_API_KEY.')
    log('')
    return persisted
  }

  const key = (await ask(`Paste your ${picked.backend} API key: `)).trim()
  if (!key) {
    log('')
    log('No key entered — skipping. Set it later with /config set apiKey <key>.')
    log('')
    return persisted
  }

  patch.llmBackend = picked.backend
  patch.apiKey = key
  await configStore.save(patch)
  log('')
  log(`✓ Saved. Using ${picked.backend}. The key is stored in plain text in your config file`)
  log('  (~/.buildaharness/personal-assistant/config.json) — the same trust boundary as a .env.')
  log('')
  return { ...persisted, ...patch }
}
