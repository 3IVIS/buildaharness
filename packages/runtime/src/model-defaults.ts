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
 * OpenRouter slug. Verified live against OpenRouter's /models endpoint — OpenRouter drops
 * slugs for decommissioned snapshots as models are retired, so this needs occasional
 * re-verification, not a "set once and forget" constant.
 */
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-5'
