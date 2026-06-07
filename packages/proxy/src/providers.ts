export type Provider = 'anthropic' | 'openai'

export function detectProvider(model: string): Provider | null {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-') || model.startsWith('o1-') || model.startsWith('o3-')) return 'openai'
  return null
}

export function getProviderUrl(provider: Provider): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages'
  return 'https://api.openai.com/v1/chat/completions'
}

export function getApiKey(provider: Provider, env: Record<string, string | undefined>): string | undefined {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY
  return env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
}
