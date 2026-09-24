/**
 * First-run setup for the CLI. `npx @buildaharness/aielia` with no
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
import { PROVIDER_SETUP, checkApiKeyFormat, cleanApiKey, type KeyTestResult, type KeyedBackend } from './provider-setup.js'

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
  /** Live-checks a key against the provider. Optional so unit tests can skip the network; cli.ts passes the real testApiKey. */
  testKey?: (backend: KeyedBackend, key: string) => Promise<KeyTestResult>
}

/** How many times the user may re-paste a rejected key before we stop nagging and let them out. */
const MAX_KEY_ATTEMPTS = 3

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

/**
 * Runs the first-run pass if needed. Returns the persisted config to use from
 * here on — unchanged when setup was skipped or the user bailed out, or a fresh
 * object reflecting what was just written.
 */
export async function maybeRunFirstRunSetup(deps: FirstRunDeps): Promise<Partial<AssistantConfig>> {
  const { configStore, persisted, isInteractive, ask, detectClaudeCli, log, testKey } = deps

  if (alreadyConfigured(deps)) return persisted
  if (!isInteractive) return persisted

  log('')
  log('Welcome to Aielia! 👋  Let’s get you set up — it takes about a minute.')
  log('')
  log('Aielia needs an AI model to think with. Pick where that comes from below.')
  log('(You can change this any time with /config, or press Ctrl+C to skip.)')
  log('')

  const patch: Partial<AssistantConfig> = {}

  if (await detectClaudeCli()) {
    log('✓ Claude is already running on this computer (Claude Code is installed and signed in).')
    log('  That means you can start right now — no API key, no extra account, nothing to paste.')
    log('')
    const useClaude = await ask('Use your Claude login? (Y/n — Enter means yes) ')
    if (useClaude === '' || useClaude.toLowerCase().startsWith('y')) {
      patch.llmBackend = 'claude-cli'
      await configStore.save(patch)
      log('')
      log('✓ All set — using your Claude login. Try "what time zone is Tokyo in?", then')
      log('  "send an email to my boss saying I quit" to see the approval gate.')
      log('')
      return { ...persisted, ...patch }
    }
    log('')
  } else {
    log('Tip: if you already use Claude Code, install it and sign in (run `claude` once), then')
    log('start Aielia again — you can use it with no API key. Otherwise, pick a provider below.')
    log('')
  }

  log('Which AI provider do you have (or want to use)?')
  log('')
  PROVIDER_SETUP.forEach((p, i) => {
    log(`  ${i + 1}) ${p.name}`)
    log(`     ${p.blurb}`)
  })
  log('')
  const choice = (await ask(`Type 1-${PROVIDER_SETUP.length} and press Enter (or just Enter to skip): `)).trim()
  const picked = PROVIDER_SETUP[Number(choice) - 1]
  if (!picked) {
    log('')
    log('Skipped. Until you set a provider, Aielia will try the "proxy" backend (needs')
    log('@buildaharness/proxy running on :8787). To set one up later, run:')
    log('  /config set llmBackend <anthropic|openai|openrouter>')
    log('  /config set apiKey <your key>')
    log('')
    return persisted
  }

  log('')
  log(`To connect ${picked.name}, you need an “API key” — a password-like code that lets Aielia use your account.`)
  log('Here’s how to get one:')
  log('')
  picked.steps.forEach((step, i) => log(`  ${i + 1}. ${step}`))
  if (picked.safety) {
    log('')
    log(`  ${picked.safety.title}:`)
    picked.safety.steps.forEach((step, i) => log(`     ${i + 1}. ${step}`))
    log(`     (${picked.safety.urlLabel})`)
  }
  log('')
  log(`The key starts with "${picked.keyPrefix}". Paste it below when you have it.`)
  log('')

  let key = ''
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const candidate = cleanApiKey(await ask('Paste your API key (or just Enter to skip): '))
    if (candidate === '') break
    const formatProblem = checkApiKeyFormat(picked.backend, candidate)
    if (formatProblem) {
      log(`  ✗ ${formatProblem}`)
      continue
    }
    if (testKey) {
      log('  Checking your key…')
      const result = await testKey(picked.backend, candidate)
      if (result.status === 'invalid') {
        log(`  ✗ ${result.message}`)
        continue
      }
      if (result.status === 'unverified') log(`  ! ${result.message}`)
    }
    key = candidate
    break
  }

  if (!key) {
    log('')
    log('No working key entered, so nothing was saved. Run Aielia again to retry, or use')
    log('/config set llmBackend ' + picked.backend + '  then  /config set apiKey <key>')
    log('')
    return persisted
  }

  patch.llmBackend = picked.backend
  patch.apiKey = key
  await configStore.save(patch)
  log('')
  log(`✓ You’re all set — using ${picked.name}. Say hello!`)
  log('  Your key is saved on this computer in ~/.buildaharness/personal-assistant/config.json')
  log('  (plain text, like a .env file) — don’t share that file.')
  log('')
  return { ...persisted, ...patch }
}
