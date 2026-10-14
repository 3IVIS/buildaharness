import {
  LLMClient,
  AnthropicLLMClient,
  OpenAICompatibleLLMClient,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_EXTRA_HEADERS,
  type ILLMClient,
} from '@buildaharness/runtime'
import type { AssistantConfig } from './config.js'

export interface LlmClientFactoryOptions {
  /** Passed to every HTTP client. The desktop app supplies Tauri's fetch, because its webview CSP blocks the global one. */
  fetchImpl?: typeof fetch
  /**
   * Builds the surface's own claude-cli client (the CLI's file/shell/web/action tools, desktop's Tauri bridge).
   * Return undefined where `claude -p` cannot run (a plain browser tab) and the factory falls back to the proxy.
   */
  claudeCli: () => ILLMClient | undefined
}

/** The one switch over the five backends. Only the claude-cli client and `fetch` differ per surface, and both come in through the options. */
export function createLlmClient(config: AssistantConfig, { fetchImpl, claudeCli }: LlmClientFactoryOptions): ILLMClient {
  switch (config.llmBackend) {
    case 'claude-cli': {
      const client = claudeCli()
      if (client) return client
      console.warn('llmBackend "claude-cli" isn\'t available in a plain browser tab (no way to run `claude -p`) — falling back to "proxy".')
      return new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken, fetchImpl })
    }
    case 'anthropic':
      return new AnthropicLLMClient({ apiKey: config.apiKey ?? '', fetchImpl })
    case 'openai':
      return new OpenAICompatibleLLMClient({ apiKey: config.apiKey ?? '', baseUrl: OPENAI_BASE_URL, defaultModel: OPENAI_DEFAULT_MODEL, fetchImpl })
    case 'openrouter':
      return new OpenAICompatibleLLMClient({
        apiKey: config.apiKey ?? '',
        baseUrl: OPENROUTER_BASE_URL,
        defaultModel: OPENROUTER_DEFAULT_MODEL,
        extraHeaders: OPENROUTER_EXTRA_HEADERS,
        fetchImpl,
      })
    case 'proxy':
      return new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken, fetchImpl })
  }
}
