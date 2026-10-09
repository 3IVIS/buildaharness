/**
 * Current-generation default model id per provider — one exported constant each, so every
 * call site (the runtime LLM clients, the personal-assistant CLI, the chat-ui browser build,
 * the Tauri desktop build) imports the same value instead of hand-typing a literal that
 * silently rots a generation behind. A call that supplies an explicit `options.model` (or a
 * `/config` override) always wins; these are only the fallback when none is given.
 *
 * scripts/check-model-defaults.mjs is the CI gate: it fails if a dated or previous-generation
 * model id (`claude-3-*`, `claude-2*`, `gpt-4*`, a bare `-20xx` snapshot suffix) reappears in
 * the runtime clients or the surfaces that display a default — this file is where the id is
 * meant to change, and nowhere else.
 *
 * This module deliberately has zero imports so both llm-client.ts and anthropic-client.ts can
 * pull from it without any import cycle.
 */

/** Anthropic Messages API — current Claude Sonnet generation. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5'

/**
 * OpenAI Chat Completions — current cheap/fast tier, the successor to the old `gpt-4o-mini`
 * default. A caller wanting the flagship tier passes `options.model` explicitly.
 */
export const OPENAI_DEFAULT_MODEL = 'gpt-5-mini'

/**
 * OpenRouter slug. Verified live against OpenRouter's /models endpoint (2026-10-09: 1M context,
 * tool calling supported) — OpenRouter drops slugs for decommissioned snapshots as models are
 * retired, so this needs occasional re-verification, not a "set once and forget" constant.
 * Deliberately not a Claude model: OpenRouter's pitch is cheap access to many models, and the
 * setup wizard points newcomers here. Anyone wanting Claude sets `model` (e.g. `anthropic/claude-sonnet-5`).
 */
export const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

/**
 * The model a backend actually runs when `config.model` is unset, so callers that need to *name*
 * it (spend/cost estimates, the model shown to the user) don't assume the Anthropic default.
 * `undefined` for backends with no fixed default (claude-cli uses the user's own Claude Code default).
 */
export function defaultModelForBackend(backend: string): string | undefined {
  switch (backend) {
    case 'anthropic':
    case 'proxy':
      return ANTHROPIC_DEFAULT_MODEL
    case 'openai':
      return OPENAI_DEFAULT_MODEL
    case 'openrouter':
      return OPENROUTER_DEFAULT_MODEL
    default:
      return undefined
  }
}
