import type { AssistantConfig } from '@buildaharness/aielia'

/** The slice of AssistantConfig that decides whether a model is reachable; a full config satisfies it. */
export interface ModelCredentials {
  llmBackend: AssistantConfig['llmBackend']
  apiKey?: string
  authToken?: string
}

/**
 * The hosted browser trial (myaielia.com/try) has no model of its own: a visitor has to bring an
 * API key. The deploy workflow marks that build with VITE_ASSISTANT_REQUIRE_KEY=true; every other
 * build (dev, self-hosted proxy, desktop) leaves it unset and behaves exactly as before.
 *
 * Read from the env object on each call rather than at module load, so tests can stub it.
 */
export function requiresOwnKey(env: ImportMetaEnv): boolean {
  return env.VITE_ASSISTANT_REQUIRE_KEY === 'true'
}

/** True when the resolved config has what its chosen backend needs to reach a model. */
export function hasModelCredentials(config: ModelCredentials): boolean {
  switch (config.llmBackend) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
      return Boolean(config.apiKey?.trim())
    case 'proxy':
      return Boolean(config.authToken?.trim())
    default:
      // claude-cli is a desktop-only backend; it needs no key from the user.
      return true
  }
}

/** The one question the UI asks: should it steer this visitor to add a key before they can chat? */
export function isKeyMissing(required: boolean, isDesktop: boolean, config: ModelCredentials): boolean {
  return required && !isDesktop && !hasModelCredentials(config)
}
