import {
  createLlmClient,
  SecretStoreError,
  SessionFallbackSecretStore,
  type AssistantConfig,
  type NetworkPort,
  type NetworkRequest,
  type SecretStore,
} from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'

/** The Tauri `invoke`, passed in so tests can fake it and a plain browser build never loads the Tauri modules. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/**
 * The tools the chat inside Email may use: none. Chat's shell and file tools (when switched on there) are never given to a chat that reads hostile mail
 * (plan section 14, per-screen isolation). Mail actions come from the mail tools of the mail chat, not from this list.
 */
export const EMAIL_CHAT_TOOLS: readonly string[] = []

/** What Email needs from the desktop app, behind the interfaces of F7. */
export interface EmailDesktopPlatform {
  /** Mail network calls, made by Rust. The webview never holds a token and never gets a general fetch. */
  network: NetworkPort
  /** Mail secrets, kept by Rust in the OS keychain by account id. */
  secrets: SecretStore
  /** The app's own model connection (no second sign-in), with no file or shell tools. */
  llm: ILLMClient
  tools: readonly string[]
  hostName: 'app'
}

/** Mail requests are made from Rust, which limits them to the mail providers' hosts; the page only describes the request. */
export function tauriNetworkPort(invoke: Invoke): NetworkPort {
  return async (req: NetworkRequest) => {
    if (req.signal?.aborted) throw new Error('request aborted')
    const res = await invoke<{ status: number; headers: Record<string, string>; body: string }>('mail_request', {
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      body: req.body ?? null,
    })
    return { status: res.status, headers: res.headers, text: async () => res.body }
  }
}

/** Prefix of the Rust error that means there is no usable keyring (typically Linux without a Secret Service). */
export const NO_KEYRING_PREFIX = 'no_keyring:'

/** A secret store over the Rust keychain commands, taking an account id. A failing command reads as unavailable, so the caller can fall back to a session-only store. */
export function tauriSecretStore(invoke: Invoke): SecretStore {
  const wrap = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Rust marks "no keyring on this machine" with this prefix; the caller then keeps the token for the session only.
      if (message.startsWith(NO_KEYRING_PREFIX)) throw new SecretStoreError('no_keyring', message)
      throw new SecretStoreError('unavailable', message)
    }
  }
  return {
    async get(accountId) { return (await wrap<string | null>('mail_secret_get', { accountId })) ?? undefined },
    async set(accountId, value) { await wrap<void>('mail_secret_set', { accountId, value }) },
    async delete(accountId) { await wrap<void>('mail_secret_delete', { accountId }) },
  }
}

/** Email inside the desktop app. The Tauri modules are imported when this runs. */
export async function desktopEmailPlatform(config: AssistantConfig, invokeFn?: Invoke, onSessionOnly?: () => void): Promise<EmailDesktopPlatform> {
  const [{ TauriClaudeCliLLMClient }, core] = await Promise.all([import('../tauri-claude-cli-llm-client'), invokeFn ? Promise.resolve(undefined) : import('@tauri-apps/api/core')])
  const invoke = invokeFn ?? (core!.invoke as Invoke)
  return {
    network: tauriNetworkPort(invoke),
    secrets: new SessionFallbackSecretStore(tauriSecretStore(invoke), onSessionOnly),
    llm: createLlmClient(config, { claudeCli: () => new TauriClaudeCliLLMClient() }),
    tools: EMAIL_CHAT_TOOLS,
    hostName: 'app',
  }
}
