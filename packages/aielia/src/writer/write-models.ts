import { ANTHROPIC_DEFAULT_MODEL, defaultModelForBackend } from '@buildaharness/runtime'

/**
 * Which models Aielia Write offers and starts with. The writer picks a model next to the chat; it is used for the chat, for edit
 * suggestions and for any check started from the chat, and every output says which model made it. Automatic checks after typing use a
 * separate, cheaper default (the plan's "smaller, different checker") that is set in Settings. A model id the writer types is always accepted:
 * the list only suggests.
 */

const SMALLER_ANTHROPIC = 'claude-haiku-5-5'
const OTHER_ANTHROPIC = ['claude-opus-5-5', SMALLER_ANTHROPIC, 'claude-fable-5-1']

/** What to call a model id in the page. The Claude CLI backend has no default id of its own (the CLI picks the model), so its id is empty: say so rather than show nothing. */
export const CLI_DEFAULT_LABEL = 'Claude default'
export const modelLabel = (model: string | undefined): string => model?.trim() || CLI_DEFAULT_LABEL

export function suggestedModels(backend: string): string[] {
  // The Claude CLI takes these aliases for --model; leaving the box empty uses the CLI's own default.
  if (backend === 'claude-cli') return ['sonnet', 'opus', 'haiku']
  const fallback = defaultModelForBackend(backend)
  if (backend === 'anthropic' || backend === 'proxy') return [ANTHROPIC_DEFAULT_MODEL, ...OTHER_ANTHROPIC]
  return fallback ? [fallback] : []
}

export interface WriteModelDefaults {
  /** For the chat, edit suggestions and checks the writer starts from the chat. */
  chat: string
  /** For checks that run by themselves after typing. */
  auto: string
}

/** `configured` is the model from the visitor's settings, when they set one. */
export function defaultWriteModels(backend: string, configured?: string): WriteModelDefaults {
  const chat = configured?.trim() || defaultModelForBackend(backend) || ''
  // A smaller model for the automatic checks where one is known; otherwise the same as the chat (Settings says so).
  const auto = backend === 'anthropic' || backend === 'proxy' ? SMALLER_ANTHROPIC : chat
  return { chat, auto }
}
