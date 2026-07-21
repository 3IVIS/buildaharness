import { invoke } from '@tauri-apps/api/core'
import type { AssistantConfig, ConfigStore } from '@buildaharness/personal-assistant'
import { FileSystemAdapter, type FsBackend } from '@buildaharness/runtime'

const CONFIG_KEY = 'settings'

/**
 * Tauri-fs-backed ConfigStore for the desktop build. Reuses FileSystemAdapter — already
 * wired for transcripts/experience/checkpoints in App.tsx's createTauriBackedAssistant() —
 * under a new "config" namespace, rather than introducing a second persistence mechanism.
 * FileSystemAdapter.set() replaces the stored value wholesale (its default 'upsert' mode is
 * not a merge), so save() does its own read-merge-write, the same contract NodeConfigStore
 * and BrowserConfigStore both provide.
 *
 * `apiKey` specifically (T7 — review §5.3) never lives in this plaintext JSON file; it's
 * routed to the OS keychain instead, via the `keychain_*_api_key` Tauri commands (see
 * lib.rs). Every other field (proxyUrl, authToken, braveApiKey, etc.) is unaffected — the
 * review singled out `apiKey` as the one field materially more valuable to move, since it's a
 * real provider key rather than a self-hosted proxy token.
 */
export class TauriConfigStore implements ConfigStore {
  private readonly adapter: FileSystemAdapter
  private migrationNoticePending = false

  constructor(opts: { backend: FsBackend; baseDir: string }) {
    this.adapter = new FileSystemAdapter({ backend: opts.backend, baseDir: opts.baseDir, namespace: 'config' })
  }

  async load(): Promise<Partial<AssistantConfig>> {
    const value = ((await this.adapter.get(CONFIG_KEY)) as Partial<AssistantConfig> | undefined) ?? {}
    const { apiKey: plaintextApiKey, ...rest } = value

    if (plaintextApiKey !== undefined) {
      // Migration path: a pre-existing plaintext apiKey predates this task. Move it into the
      // keychain and rewrite the plaintext file without it — done here (not save()) so it
      // happens on the very next load() after this ships, without requiring the user to touch
      // Settings first. If keychain_set_api_key fails, the plaintext copy is deliberately left
      // in place (not stripped) so the key is never lost mid-migration — see this task's own
      // "must never lose a user's existing API key mid-migration" requirement; the error
      // propagates so the caller sees it rather than the failure being silently swallowed.
      await invoke('keychain_set_api_key', { secret: plaintextApiKey })
      await this.adapter.set(CONFIG_KEY, rest)
      this.migrationNoticePending = true
    }

    const apiKey = plaintextApiKey ?? ((await invoke<string | null>('keychain_get_api_key')) ?? undefined)
    return { ...rest, apiKey }
  }

  async save(patch: Partial<AssistantConfig>): Promise<void> {
    const { apiKey, ...patchRest } = patch
    const existing = await this.load()
    const { apiKey: _existingApiKey, ...existingRest } = existing
    await this.adapter.set(CONFIG_KEY, { ...existingRest, ...patchRest })

    // Only touch the keychain if this patch actually mentions apiKey — an unrelated settings
    // change (e.g. toggling enableWeb) must never re-write or clear it.
    if ('apiKey' in patch) {
      if (apiKey === undefined) {
        await invoke('keychain_delete_api_key')
      } else {
        await invoke('keychain_set_api_key', { secret: apiKey })
      }
    }
  }

  /**
   * One-time signal for the caller (App.tsx) to show a "your API key moved to the OS
   * keychain" notice — true only immediately after a load() that just performed the
   * migration above. Reading it clears it, so it's never shown twice for the same migration.
   */
  consumeMigrationNotice(): boolean {
    const pending = this.migrationNoticePending
    this.migrationNoticePending = false
    return pending
  }
}
