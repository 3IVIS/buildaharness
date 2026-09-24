/**
 * Provider metadata + API-key checking shared by every first-run surface (the CLI's
 * first-run.ts and chat-ui's SetupWizard), so the CLI and the GUI give a new user the same
 * names, "where do I get a key" links, and error wording instead of drifting apart.
 *
 * Browser-safe on purpose (no Node imports; `fetch` is injectable) — it is re-exported from
 * index.ts and imported by chat-ui.
 */

import type { AssistantConfig } from './config.js'

export type KeyedBackend = Extract<AssistantConfig['llmBackend'], 'anthropic' | 'openai' | 'openrouter'>

export interface ProviderSetupInfo {
  backend: KeyedBackend
  /** Plain-language name shown to the user. */
  name: string
  /** One line on who this is for / what it costs, for someone who has never done this before. */
  blurb: string
  /** Where the user creates a key. */
  keyUrl: string
  /** Human-readable form of `keyUrl` for terminals. */
  keyUrlLabel: string
  /** Numbered walkthrough for someone with no account yet — shown before the key prompt. Plain text, no markup. */
  steps: readonly string[]
  /** Optional "protect your wallet" walkthrough, shown alongside `steps`. */
  safety?: { title: string; url: string; urlLabel: string; steps: readonly string[] }
  /** What a valid key starts with — used for a fast, offline sanity check and as the input placeholder. */
  keyPrefix: string
}

export const PROVIDER_SETUP: readonly ProviderSetupInfo[] = [
  {
    backend: 'openrouter',
    name: 'OpenRouter',
    blurb: 'Best if you’re new to this: one account for many AI models, prepaid credits, and spending limits you control.',
    keyUrl: 'https://openrouter.ai/keys',
    keyUrlLabel: 'openrouter.ai/keys',
    keyPrefix: 'sk-or-',
    steps: [
      'Go to openrouter.ai and sign up (Google, GitHub or email all work).',
      'Add a few dollars of credit at openrouter.ai/settings/credits. $5 goes a long way. Credits are prepaid, so you can’t spend more than you add — leave “auto top-up” off unless you want it.',
      'Open openrouter.ai/keys, click “Create key”, name it “Aielia”, and copy it right away (it is only shown once).',
    ],
    safety: {
      title: 'Set a spending limit (recommended, 2 minutes)',
      url: 'https://openrouter.ai/workspaces/default/guardrails',
      urlLabel: 'openrouter.ai/workspaces/default/guardrails',
      steps: [
        'Open the Guardrails page and click “New Guardrail”.',
        'Set a spending cap in dollars — for example $5 per month. Requests are refused once it is reached, so a runaway task can’t surprise you.',
        'Optional: under model or provider allowlists, pick only the models you’re happy to use (leave empty to allow all).',
        'Save it, then assign it to the key you just created.',
      ],
    },
  },
  {
    backend: 'anthropic',
    name: 'Anthropic (Claude)',
    blurb: 'Direct from the makers of Claude. Pay-as-you-go with prepaid credit.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyUrlLabel: 'console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    steps: [
      'Go to console.anthropic.com and sign up or sign in.',
      'Add a few dollars of credit under Billing (the API is billed separately from a Claude chat subscription).',
      'Open console.anthropic.com/settings/keys, click “Create Key”, and copy it right away.',
    ],
  },
  {
    backend: 'openai',
    name: 'OpenAI (ChatGPT models)',
    blurb: 'Pay-as-you-go. Needs billing enabled on your OpenAI account.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyUrlLabel: 'platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    steps: [
      'Go to platform.openai.com and sign up or sign in.',
      'Add a few dollars of credit under Billing (the API is billed separately from a ChatGPT subscription).',
      'Open platform.openai.com/api-keys, click “Create new secret key”, and copy it right away.',
    ],
  },
]

export function getProviderSetup(backend: KeyedBackend): ProviderSetupInfo {
  const info = PROVIDER_SETUP.find((p) => p.backend === backend)
  if (!info) throw new Error(`No setup info for backend "${backend}"`)
  return info
}

/** Pasted keys often carry stray whitespace, newlines, or wrapping quotes — strip them before anything else looks at the value. */
export function cleanApiKey(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim()
}

/**
 * Offline check for the mistakes a first-timer actually makes: pasting nothing, pasting a key
 * for a different provider, or pasting a sentence. Returns null when the key looks plausible
 * (which is not the same as valid — see testApiKey), otherwise a message to show the user.
 */
export function checkApiKeyFormat(backend: KeyedBackend, key: string): string | null {
  const info = getProviderSetup(backend)
  if (key === '') return 'Nothing was pasted. Copy the key from the provider’s website and paste it here.'
  if (/\s/.test(key)) return 'That contains spaces — an API key is a single unbroken string. Make sure you copied only the key.'
  // OpenRouter and Anthropic keys are also "sk-…" shaped, so only flag a mismatch when we can be sure.
  if (backend === 'anthropic' && !key.startsWith('sk-ant-')) {
    return key.startsWith('sk-or-')
      ? 'That looks like an OpenRouter key, not an Anthropic one. Go back and pick OpenRouter, or paste an Anthropic key (starts with sk-ant-).'
      : `Anthropic keys start with ${info.keyPrefix}. Double-check you copied the right one.`
  }
  if (backend === 'openrouter' && !key.startsWith('sk-or-')) {
    return `OpenRouter keys start with ${info.keyPrefix}. Double-check you copied the right one.`
  }
  if (backend === 'openai' && (!key.startsWith('sk-') || key.startsWith('sk-ant-') || key.startsWith('sk-or-'))) {
    return key.startsWith('sk-ant-')
      ? 'That looks like an Anthropic key, not an OpenAI one. Go back and pick Anthropic, or paste an OpenAI key (starts with sk-).'
      : `OpenAI keys start with ${info.keyPrefix}. Double-check you copied the right one.`
  }
  if (key.length < 20) return 'That looks too short to be a full API key. Make sure you copied the whole thing.'
  return null
}

export type KeyTestResult =
  | { status: 'valid' }
  | { status: 'invalid'; message: string }
  /** Couldn't reach the provider (offline, blocked, CORS…) — the key may still be fine, so callers let the user continue. */
  | { status: 'unverified'; message: string }

/**
 * Asks the provider a free, read-only question ("list models" / "who am I") to find out
 * whether the key is accepted, so a typo surfaces during setup instead of as an opaque error
 * on the user's first message. Never throws.
 */
export async function testApiKey(
  backend: KeyedBackend,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyTestResult> {
  const request: { url: string; headers: Record<string, string> } =
    backend === 'anthropic'
      ? {
          url: 'https://api.anthropic.com/v1/models?limit=1',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        }
      : backend === 'openai'
        ? { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }
        : { url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${key}` } }

  const name = getProviderSetup(backend).name
  let response: Response
  try {
    response = await fetchImpl(request.url, { method: 'GET', headers: request.headers, signal: AbortSignal.timeout(10_000) })
  } catch {
    return {
      status: 'unverified',
      message: `Couldn’t reach ${name} to check the key — are you online? You can continue anyway and it will be tried on your first message.`,
    }
  }
  if (response.ok) return { status: 'valid' }
  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid', message: `${name} didn’t accept that key. Check that you copied all of it and that it hasn’t been deleted.` }
  }
  return {
    status: 'unverified',
    message: `${name} answered with an unexpected error (HTTP ${response.status}), so the key couldn’t be checked. You can continue anyway.`,
  }
}
